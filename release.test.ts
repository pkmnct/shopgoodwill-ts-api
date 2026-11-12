import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Runs the release plugins' commit analysis and release-notes generation with
// the repository's own .releaserc.json, so a preset/writer mismatch or a
// config that stops recognising `feat!:` fails here instead of in the release
// run on main (which is also the publish).

type PluginConfig = Record<string, unknown>;
type Context = Record<string, unknown>;
type Analyze = (config: PluginConfig, context: Context) => Promise<string | null>;
type Notes = (config: PluginConfig, context: Context) => Promise<string>;

const load = async <T>(name: string): Promise<T> => (await import(name)) as T;

const releaseConfig = JSON.parse(readFileSync(".releaserc.json", "utf8")) as {
  plugins: (string | [string, PluginConfig])[];
};

const optionsFor = (name: string): PluginConfig => {
  const entry = releaseConfig.plugins.find(
    (plugin) => (Array.isArray(plugin) ? plugin[0] : plugin) === name
  );
  assert.ok(entry, `${name} is not in .releaserc.json`);
  return Array.isArray(entry) ? entry[1] : {};
};

const commit = (message: string) => ({
  hash: "9aea5015519e76ff4a252d757032c302384d9853",
  message,
  committerDate: new Date().toISOString(),
});

const logger = { log: () => undefined };

describe("release configuration", () => {
  it("maps conventional commit titles to release types", async () => {
    const { analyzeCommits } = await load<{ analyzeCommits: Analyze }>(
      "@semantic-release/commit-analyzer"
    );
    const typeOf = (message: string) =>
      analyzeCommits(optionsFor("@semantic-release/commit-analyzer"), {
        cwd: process.cwd(),
        commits: [commit(message)],
        logger,
      });

    assert.equal(await typeOf("feat!: drop node 16"), "major");
    assert.equal(await typeOf("feat: add a method"), "minor");
    assert.equal(await typeOf("fix: handle an empty body"), "patch");
    assert.equal(await typeOf("ci: change a workflow"), null);
  });

  it("generates release notes with the configured preset", async () => {
    const { generateNotes } = await load<{ generateNotes: Notes }>(
      "@semantic-release/release-notes-generator"
    );
    const notes = await generateNotes(
      optionsFor("@semantic-release/release-notes-generator"),
      {
        cwd: process.cwd(),
        options: { repositoryUrl: "https://github.com/pkmnct/shopgoodwill-ts-api.git" },
        commits: [commit("feat!: drop node 16\n\nBREAKING CHANGE: Node 22+")],
        lastRelease: { gitTag: "v1.1.0", version: "1.1.0" },
        nextRelease: { gitTag: "v2.0.0", version: "2.0.0", gitHead: "9aea501" },
        logger,
      }
    );

    assert.match(notes, /## \[2\.0\.0\]\(.*compare\/v1\.1\.0\.\.\.v2\.0\.0\)/);
    assert.match(notes, /### ⚠ BREAKING CHANGES\s+\* Node 22\+/);
    assert.match(notes, /### Features\s+\* drop node 16 .*9aea501/);
  });

  it("pairs the notes preset with the writer the release plugin bundles", () => {
    // conventional-changelog-conventionalcommits N+1 needs
    // conventional-changelog-writer N. A semantic-release update that moves
    // the bundled writer fails here, which is the prompt to move the preset
    // (and the Dependabot ignore rule) to the next major.
    // package.json is not exported by these packages: walk up from the entry
    // file to the node_modules folder that holds the dependency
    const versionFrom = (entry: string, name: string): number => {
      for (let dir = dirname(entry); dir !== dirname(dir); dir = dirname(dir)) {
        const file = join(dir, "node_modules", name, "package.json");
        if (existsSync(file)) {
          const { version } = JSON.parse(readFileSync(file, "utf8")) as {
            version: string;
          };
          return Number(version.split(".")[0]);
        }
      }
      throw new Error(`${name} not found from ${entry}`);
    };
    // import.meta.resolve honours the "import" condition, so ESM-only
    // packages (preset 10+) resolve too
    const pluginEntry = fileURLToPath(
      import.meta.resolve("@semantic-release/release-notes-generator")
    );
    const presetEntry = fileURLToPath(
      import.meta.resolve("conventional-changelog-conventionalcommits")
    );

    const writer = versionFrom(pluginEntry, "conventional-changelog-writer");
    const preset = versionFrom(
      presetEntry,
      "conventional-changelog-conventionalcommits"
    );
    assert.equal(
      preset,
      writer + 1,
      `conventional-changelog-writer ${writer} is bundled, so the preset must be ${writer + 1}.x (it is ${preset}.x): update the preset and the ignore rule in .github/dependabot.yml`
    );
  });
});
