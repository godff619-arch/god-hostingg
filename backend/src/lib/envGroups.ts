// Environment Groups: resolution of the variables a resource actually deploys
// with.
//
// A group belongs to a workspace and is linked to environments. Every resource
// inside a linked environment inherits the group's variables. Precedence is
// fixed and one-directional: the resource's own `EnvVariable` rows always win
// over anything a group contributes, so linking a group can never silently
// change a value someone set on the service itself.
//
// Values are sealed at rest (`secretBox`). `open()` is used here because the
// server itself is the consumer — the plaintext goes into the compose file, not
// into an API response.

import prisma from './prisma.js';
import { open } from './secretBox.js';
import { SHARED_ENV_SERVICE, type ScopedEnvVar } from './envVariables.js';

/** A variable as the deploy path consumes it, tagged with where it came from. */
export type ResolvedEnvVar = ScopedEnvVar & {
  key: string;
  value: string;
  service_name: string;
  is_build_arg: boolean;
  is_runtime: boolean;
  is_secret: boolean;
  source: 'project' | 'group';
  /** Group that contributed the variable; null for the project's own rows. */
  group_name: string | null;
};

/** Group variables inherited by a resource through its environment's links. */
export async function envGroupVarsForEnvironment(
  environmentId: string | null | undefined,
): Promise<ResolvedEnvVar[]> {
  if (!environmentId) return [];

  const links = await prisma.envGroupLink.findMany({
    where: { environment_id: environmentId },
    orderBy: { created_at: 'asc' },
    include: {
      group: {
        include: { vars: { orderBy: { key: 'asc' } } },
      },
    },
  });

  const out: ResolvedEnvVar[] = [];
  for (const link of links) {
    for (const row of link.group.vars) {
      const value = open(row.value_enc);
      // A value that cannot be opened (rotated key) is dropped rather than
      // injected as an empty string, which would look like a real setting.
      if (value === null) {
        console.warn(
          `[envGroups] ${link.group.name}.${row.key} could not be decrypted — skipped`,
        );
        continue;
      }
      out.push({
        key: row.key,
        value,
        service_name: SHARED_ENV_SERVICE,
        is_build_arg: false,
        is_runtime: true,
        is_secret: row.is_secret,
        source: 'group',
        group_name: link.group.name,
      });
    }
  }
  return out;
}

/**
 * Everything a project deploys with: linked group variables first, the
 * project's own rows after. `envForService()` lets a later row of the same
 * scope win, so this ordering is what gives the project precedence.
 */
export async function resolvedEnvForProject(projectId: string): Promise<ResolvedEnvVar[]> {
  const [project, own] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: { environment_id: true },
    }),
    prisma.envVariable.findMany({ where: { project_id: projectId } }),
  ]);

  const inherited = await envGroupVarsForEnvironment(project?.environment_id);

  return [
    ...inherited,
    ...own.map<ResolvedEnvVar>((row) => ({
      key: row.key,
      value: row.value,
      service_name: row.service_name ?? SHARED_ENV_SERVICE,
      is_build_arg: row.is_build_arg ?? false,
      is_runtime: row.is_runtime ?? true,
      is_secret: row.is_secret ?? false,
      source: 'project',
      group_name: null,
    })),
  ];
}
