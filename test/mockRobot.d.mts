export function startMockRobot(dir: string, httpPort?: number, ftpPort?: number, opts?: { runningProgram?: string; runningLine?: number }): {
  httpPort: number; ftpPort: number; state: { tick: number; runningProgram: string; runningLine: number; r151: number }; uploads: Map<string, Buffer>; close(): Promise<void>;
};
