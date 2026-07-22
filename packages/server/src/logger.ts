import { configure, getConsoleSink, getLogger } from "@logtape/logtape";

let configured = false;

export const setupLogger = async (
  level: "trace" | "debug" | "info" | "warning" | "error" | "fatal" = "info",
  category: string = "niuma.server",
): Promise<void> => {
  if (configured) return;
  configured = true;
  await configure({
    sinks: { console: getConsoleSink() },
    filters: {},
    loggers: [
      { category: "niuma", lowestLevel: level, sinks: ["console"] },
      { category, lowestLevel: level, sinks: ["console"] },
      { category: "niuma.server.http", lowestLevel: level, sinks: ["console"] },
      { category: "niuma.server.kernel", lowestLevel: level, sinks: ["console"] },
      { category: "niuma.server.projection", lowestLevel: level, sinks: ["console"] },
    ],
  });
};

export const log = (category: string = "niuma.server") => getLogger(category);