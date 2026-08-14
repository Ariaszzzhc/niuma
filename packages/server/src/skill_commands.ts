// ===========================================================================
// Skills as slash commands: a skill is not only loaded by the model through
// the `skill` tool — a human can also trigger it as `/name args`, the same
// gesture as custom slash commands (opencode registers skills into its
// command registry; niuma merges them into the command table instead).
//
// mergeSkillCommands overlays the bootstrap-time skills map onto a freshly
// discovered CommandTable. Precedence per name: built-in commands (TUI-local
// dispatch, never reach the server) > commands/*.md > skill — so only names
// the commands table does not have are filled from skills. A skill maps to a
// CommandDef with template = body; expansion, sourceText preservation, and
// the listing endpoints then share the existing commands code path verbatim.
// ===========================================================================

import { join } from "@std/path";
import {
  type CommandTable,
  SKILL_FILE_BASENAME,
  type SkillDef,
} from "@niuma/config";

/**
 * Merge discovered skills into a command table. Skills with a name the
 * table already has are skipped (commands/*.md wins); an empty skills map
 * returns the input table unchanged.
 */
export const mergeSkillCommands = (
  commands: CommandTable,
  skills: ReadonlyMap<string, SkillDef>,
): CommandTable => {
  if (skills.size === 0) return commands;
  const merged = new Map(commands);
  for (const skill of skills.values()) {
    if (merged.has(skill.name)) continue;
    merged.set(skill.name, {
      name: skill.name,
      description: skill.description,
      template: skill.body,
      source: skill.source,
      filePath: join(skill.dir, SKILL_FILE_BASENAME),
    });
  }
  return merged;
};
