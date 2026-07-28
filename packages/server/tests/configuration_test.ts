// ===========================================================================
// @niuma/server — Server-owned runtime configuration tests
// ---------------------------------------------------------------------------
// Runtime updates persist to config.toml before replacing the in-memory view.
// The configuration service deliberately has no watcher/reload path.
// ===========================================================================

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { ConfigError, parseConfig } from "@niuma/config";
import { makeConfigurationRuntime } from "../src/configuration.ts";

Deno.test("ConfigurationRuntime writes the closest project level before publishing", async () => {
  const root = await Deno.makeTempDir({ prefix: "niuma_configuration_" });
  try {
    const globalConfigPath = join(root, "user", "config.toml");
    const workspace = join(root, "repo", "package");
    const projectConfigPath = join(root, "repo", ".niuma", "config.toml");
    await Deno.mkdir(join(root, "user"), { recursive: true });
    await Deno.mkdir(join(root, "repo", ".niuma"), { recursive: true });
    await Deno.mkdir(workspace, { recursive: true });
    await Deno.writeTextFile(
      globalConfigPath,
      `input_delivery = "steer"\n`,
    );
    await Deno.writeTextFile(
      projectConfigPath,
      `# project\ninput_delivery = "steer"\n`,
    );

    const runtime = makeConfigurationRuntime({
      config: parseConfig(`input_delivery = "steer"`),
      workspace,
      globalConfigPath,
    });
    assertEquals(runtime.clientConfig(), { inputDelivery: "steer" });
    assertEquals(await runtime.setInputDelivery("queue"), {
      inputDelivery: "queue",
    });
    assertEquals(
      parseConfig(await Deno.readTextFile(projectConfigPath)).inputDelivery,
      "queue",
    );
    assertEquals(
      parseConfig(await Deno.readTextFile(globalConfigPath)).inputDelivery,
      "steer",
    );

    // A later malformed external edit is not auto-reloaded. It only matters
    // when an explicit update tries to persist, and a failed persist must not
    // publish the requested value into this Server's snapshot.
    await Deno.writeTextFile(projectConfigPath, "not valid = [");
    assertEquals(runtime.clientConfig(), { inputDelivery: "queue" });
    await assertRejects(
      () => runtime.setInputDelivery("steer"),
      ConfigError,
    );
    assertEquals(runtime.clientConfig(), { inputDelivery: "queue" });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
