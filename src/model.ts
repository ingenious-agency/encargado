export type Role = "workload" | "dependency" | "tooling";
export type Scope = "worktree" | "project";
export interface ServiceSpec {
  driver: "compose" | "elixir";
  role: Role;
  scope: Scope;
  purpose?: string;
  dependsOn: string[];
  command?: string[];
  files?: string[];
  profiles?: string[];
  environment: Record<string, string>;
  environmentFiles: string[];
  ports: Record<string, number>;
  ready?: { path: string; statuses: number[]; timeout: number; websocketPath?: string };
  urls: string[];
}
export interface Manifest {
  version: 1;
  project: { name: string; description?: string };
  services: Record<string, ServiceSpec>;
}
export interface Project { id: string; name: string; description?: string; path: string; gitCommonDir: string }
export interface Checkout { id: string; projectId: string; path: string; manifestPath: string; services: Record<string, string> }
export interface Endpoint { name: string; serviceName: string; hostname: string; url: string }
export interface Service {
  id: string; projectId: string; name: string; cwd: string; spec: ServiceSpec;
  definition: string; consumers: string[]; dependencies: string[];
  ports: Record<string, number>; unit: string; composeProject: string; dataDir: string;
  desired: "stopped" | "running"; status: "stopped" | "starting" | "running" | "failed" | "unknown";
  error?: string; endpoints: Endpoint[]; routeError?: string;
}
export interface Registry { version: 1; projects: Record<string, Project>; checkouts: Record<string, Checkout>; services: Record<string, Service> }
export interface Settings {
  stateDir: string; socket: string; landingPort: number;
  portRange: [number, number];
  tailscale?: {
    domain: string; command: string[]; serveConfigFile?: string;
    allowedUsers: string[]; apiTokenEnv?: string; tags?: string[];
  };
}
export interface Command { file: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number }
export interface CommandResult { code: number; stdout: string; stderr: string }
export type Runner = (command: Command) => Promise<CommandResult>;
export class Problem extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
export const emptyRegistry = (): Registry => ({ version: 1, projects: {}, checkouts: {}, services: {} });
