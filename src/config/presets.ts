/**
 * Named bundles of setting values for the configuration panel.
 *
 * Pure: a preset is data, so the panel, the tests and the docs all read the same
 * table. A preset only ever names keys that exist in the registry (enforced by
 * `presetProblems()` and the unit tests) — a preset that silently does nothing is
 * worse than no preset.
 */

import { setting } from "./registry";

export interface Preset {
  id: string;
  /** English; the panel localizes this through `src/i18n/t.ts`. */
  title: string;
  description: string;
  /** Key -> value, applied in order. */
  values: Readonly<Record<string, unknown>>;
}

export const PRESETS: readonly Preset[] = [
  {
    id: "defaults",
    title: "Defaults",
    description: "Put every mcpp setting back to its shipped default.",
    values: {},
  },
  {
    id: "quiet",
    title: "Quiet",
    description: "No status-bar counters, no automatic refresh, no editor diagnostics from this extension.",
    values: {
      "mcpp.cache.statusBar": false,
      "mcpp.cache.autoRefreshSeconds": 0,
      "mcpp.languageService.stateRefreshSeconds": 0,
      "mcpp.ui.notifications.success": "silent",
      "mcpp.task.focusTerminal": false,
      "mcpp.toml.diagnostics.unknownKey": "off",
      "mcpp.toml.diagnostics.legacyKeys": "off",
      "mcpp.buildScript.diagnostics": false,
    },
  },
  {
    id: "everything",
    title: "Everything on",
    description: "All observation and editing help enabled, including the ones that run mcpp a little more often.",
    values: {
      "mcpp.cache.statusBar": true,
      "mcpp.cache.autoRefreshSeconds": 60,
      "mcpp.cache.warnAboveGiB": 10,
      "mcpp.languageService.readState": true,
      "mcpp.languageService.stateRefreshSeconds": 30,
      "mcpp.languageService.notifyOnDegraded": true,
      "mcpp.toml.hover": true,
      "mcpp.toml.navigation": true,
      "mcpp.toml.diagnostics.enabled": true,
      "mcpp.toml.diagnostics.unknownSection": "warning",
      "mcpp.toml.diagnostics.unknownKey": "warning",
      "mcpp.toml.diagnostics.planeSeparation": "warning",
      "mcpp.toml.diagnostics.legacyKeys": "info",
      "mcpp.buildScript.intelligence": true,
      "mcpp.buildScript.diagnostics": true,
      "mcpp.buildScript.snippets": true,
      "mcpp.buildScript.imports.knownModules": true,
      "mcpp.views.cache.topN": 10,
      "mcpp.ui.notifications.success": "statusBar",
      "mcpp.log.level": "info",
    },
  },
  {
    id: "diagnose",
    title: "Diagnose",
    description: "Turn the logging up and read the C++ Modules state, for when something is wrong.",
    values: {
      "mcpp.log.level": "debug",
      "mcpp.languageService.readState": true,
      "mcpp.languageService.stateRefreshSeconds": 15,
      "mcpp.languageService.notifyOnDegraded": true,
      "mcpp.diagnostics.selfCheckOnStartup": true,
      "mcpp.toml.diagnostics.unknownSection": "warning",
      "mcpp.toml.diagnostics.unknownKey": "warning",
    },
  },
];

export function preset(id: string): Preset | undefined {
  return PRESETS.find((entry) => entry.id === id);
}

/** The key/value pairs a preset would write. `defaults` writes nothing: see `resetKeys()`. */
export function presetValues(id: string): Array<{ key: string; value: unknown }> {
  const found = preset(id);
  if (found === undefined) {
    return [];
  }
  return Object.entries(found.values).map(([key, value]) => ({ key, value }));
}

/** Registry keys a preset mentions that do not exist (must be empty). */
export function presetProblems(): string[] {
  const problems: string[] = [];
  for (const entry of PRESETS) {
    for (const key of Object.keys(entry.values)) {
      if (setting(key) === undefined) {
        problems.push(`preset ${entry.id} names unknown setting ${key}`);
      }
    }
  }
  return problems;
}
