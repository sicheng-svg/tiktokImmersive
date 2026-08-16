type LogLevel = "info" | "warn" | "error";

export interface Logger {
  info(message: string, context?: unknown): void;
  warn(message: string, context?: unknown): void;
  error(message: string, context?: unknown): void;
}

export function createLogger(scope: string): Logger {
  const write = (level: LogLevel, message: string, context?: unknown): void => {
    const prefix = `[DouyinEnglish][${scope}]`;
    if (context === undefined) {
      console[level](`${prefix} ${message}`);
      return;
    }
    console[level](`${prefix} ${message}`, context);
  };

  return {
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, context) => write("error", message, context),
  };
}
