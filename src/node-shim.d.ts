declare const process: { argv: string[]; exit(code?: number): never };
declare module "node:crypto" { export function randomUUID(): string; }
declare module "node:fs/promises" {
  export function appendFile(path: string, data: string, encoding: string): Promise<void>;
  export function mkdir(path: string, options: { recursive: boolean }): Promise<void>;
  export function readFile(path: string, encoding: string): Promise<string>;
}
declare module "node:path" { export function dirname(path: string): string; }
