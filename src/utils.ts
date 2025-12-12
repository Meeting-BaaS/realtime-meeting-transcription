import { getProcessLogger } from "./processLogger";

// Simple logging utility that writes to both console and ProcessLogger
export function createLogger(name: string) {
  return {
    info: (message: string, ...args: any[]) => {
      console.log(`[${name}] [INFO] ${message}`, ...args);
      const processLogger = getProcessLogger();
      processLogger?.info(message, name, args.length > 0 ? args : undefined);
    },
    error: (message: string, ...args: any[]) => {
      console.error(`[${name}] [ERROR] ${message}`, ...args);
      const processLogger = getProcessLogger();
      processLogger?.error(message, name, args.length > 0 ? args : undefined);
    },
    warn: (message: string, ...args: any[]) => {
      console.warn(`[${name}] [WARN] ${message}`, ...args);
      const processLogger = getProcessLogger();
      processLogger?.warn(message, name, args.length > 0 ? args : undefined);
    },
  };
}
