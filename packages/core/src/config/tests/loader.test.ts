import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — node:fs
// ---------------------------------------------------------------------------
const { mockExistsSync, mockReadFileSync, mockMkdirSync, mockWriteFileSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  mkdirSync: mockMkdirSync,
  writeFileSync: mockWriteFileSync,
}));

vi.mock("fs", () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  mkdirSync: mockMkdirSync,
  writeFileSync: mockWriteFileSync,
}));

// ---------------------------------------------------------------------------
// System under test (import triggers the mock resolution)
// ---------------------------------------------------------------------------
import { loadConfig, writeConfig } from "../loader.js";
import { ConfigError } from "../../errors.js";

// Helper: simulate a well-formed settings.json
const VALID_JSON = JSON.stringify({
  default_provider: "openai",
  default_model: "gpt-4o",
});

const VALID_CONFIG = JSON.parse(VALID_JSON);

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.VERA_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  process.env.VERA_HOME = "/tmp/global-vera-home";
});

afterEach(() => {
  delete process.env.VERA_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.VERA_HOME;
});

// ===========================================================================
// path: src/config/loader.test.ts
// ===========================================================================
describe("loadConfig", () => {
  // -----------------------------------------------------------------------
  // Explicit configPath
  // -----------------------------------------------------------------------
  describe("explicit configPath", () => {
    it("resolves the given path and reads the file directly", () => {
      const absPath = `${process.cwd()}/.vera/settings.json`;
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(VALID_JSON);

      const config = loadConfig(".vera/settings.json");

      // existsSync called with the resolved absolute path
      expect(mockExistsSync).toHaveBeenCalledWith(absPath);
      expect(mockReadFileSync).toHaveBeenCalledWith(absPath, "utf-8");
      expect(config).toEqual(VALID_CONFIG);
    });
  });

  // -----------------------------------------------------------------------
  // VERA_CONFIG_DIR env var
  // -----------------------------------------------------------------------
  describe("VERA_CONFIG_DIR env var", () => {
    it("reads settings.json from VERA_CONFIG_DIR when no configPath given", () => {
      process.env.VERA_CONFIG_DIR = "/custom/config/dir";
      const expectedPath = "/custom/config/dir/settings.json";
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(VALID_JSON);

      const config = loadConfig();

      expect(mockExistsSync).toHaveBeenCalledWith(expectedPath);
      expect(mockReadFileSync).toHaveBeenCalledWith(expectedPath, "utf-8");
      expect(config).toEqual(VALID_CONFIG);
    });

    it("overrides VERA_CONFIG_DIR when explicit configPath is also given", () => {
      process.env.VERA_CONFIG_DIR = "/custom/config/dir";
      const absPath = `${process.cwd()}/explicit.json`;
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(VALID_JSON);

      const config = loadConfig("explicit.json");

      // explicit path takes precedence—VERA_CONFIG_DIR is ignored
      expect(mockExistsSync).toHaveBeenCalledWith(absPath);
      expect(config).toEqual(VALID_CONFIG);
    });
  });

  // -----------------------------------------------------------------------
  // Default .vera/settings.json
  // -----------------------------------------------------------------------
  describe("default config resolution", () => {
    it("uses cwd/.vera/settings.json when present", () => {
      const expectedPath = `${process.cwd()}/.vera/settings.json`;
      mockExistsSync.mockImplementation((path) => path === expectedPath);
      mockReadFileSync.mockReturnValue(VALID_JSON);

      const config = loadConfig();

      expect(mockExistsSync).toHaveBeenCalledWith(expectedPath);
      expect(mockReadFileSync).toHaveBeenCalledWith(expectedPath, "utf-8");
      expect(config).toEqual(VALID_CONFIG);
    });

    it("falls back to global config when project config is missing", () => {
      const projectPath = `${process.cwd()}/.vera/settings.json`;
      const globalPath = "/tmp/global-vera-home/.vera/settings.json";
      mockExistsSync.mockImplementation((path) => path === globalPath);
      mockReadFileSync.mockReturnValue(VALID_JSON);

      const config = loadConfig();

      expect(mockExistsSync).toHaveBeenCalledWith(projectPath);
      expect(mockExistsSync).toHaveBeenCalledWith(globalPath);
      expect(mockReadFileSync).toHaveBeenCalledWith(globalPath, "utf-8");
      expect(config).toEqual(VALID_CONFIG);
    });
  });

  // -----------------------------------------------------------------------
  // File not found
  // -----------------------------------------------------------------------
  describe("file not found", () => {
    it("returns empty object {} when file does not exist at default path", () => {
      mockExistsSync.mockReturnValue(false);

      const config = loadConfig();

      expect(config).toEqual({});
      // readFileSync must NOT be called when existsSync is false
      expect(mockReadFileSync).not.toHaveBeenCalled();
    });

    it("migrates global Claude Code settings when Vera configs are missing", () => {
      const claudeDir = "/tmp/claude-config";
      const claudePath = `${claudeDir}/settings.json`;
      const globalDir = "/tmp/global-vera-home/.vera";
      const globalPath = `${globalDir}/settings.json`;
      const authKey = ["ANTHROPIC", "AUTH", "TOKEN"].join("_");
      const baseUrlKey = ["ANTHROPIC", "BASE", "URL"].join("_");
      const apiValue = "not-sensitive";
      process.env.CLAUDE_CONFIG_DIR = claudeDir;
      mockExistsSync.mockImplementation((path) => path === claudePath);
      mockReadFileSync.mockImplementation((path) => {
        if (path !== claudePath) throw new Error("unexpected read");
        return JSON.stringify({
          env: {
            [authKey]: apiValue,
            [baseUrlKey]: "http://127.0.0.1:15721",
            ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-custom",
            ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: "fast-model",
            ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-custom",
            ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "strong-model",
            ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-custom",
            ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "strong-model",
          },
        });
      });

      const config = loadConfig();

      expect(config.default_provider).toBe("claude-code");
      expect(config.routing).toMatchObject({
        classifier: "fast-model",
        l1: "strong-model",
        l2: "strong-model-opus",
      });
      expect(mockMkdirSync).toHaveBeenCalledWith(globalDir, { recursive: true });
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        globalPath,
        expect.stringContaining('"default_provider": "claude-code"'),
        "utf-8",
      );
    });

    it("returns empty object {} when file does not exist at explicit path", () => {
      mockExistsSync.mockReturnValue(false);

      const config = loadConfig("/nonexistent/config.json");

      expect(config).toEqual({});
      expect(mockReadFileSync).not.toHaveBeenCalled();
    });

    it("returns empty object {} when file does not exist at VERA_CONFIG_DIR", () => {
      process.env.VERA_CONFIG_DIR = "/nowhere";
      mockExistsSync.mockReturnValue(false);

      const config = loadConfig();

      expect(config).toEqual({});
      expect(mockReadFileSync).not.toHaveBeenCalled();
    });
  });

  describe("writeConfig", () => {
    it("writes project config when it exists", () => {
      const projectPath = `${process.cwd()}/.vera/settings.json`;
      mockExistsSync.mockImplementation((path) => path === projectPath);

      writeConfig(VALID_CONFIG);

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        projectPath,
        JSON.stringify(VALID_CONFIG, null, 2) + "\n",
        "utf-8",
      );
    });

    it("creates global config when neither project nor global config exists", () => {
      const globalDir = "/tmp/global-vera-home/.vera";
      const globalPath = `${globalDir}/settings.json`;
      mockExistsSync.mockReturnValue(false);

      writeConfig(VALID_CONFIG);

      expect(mockMkdirSync).toHaveBeenCalledWith(globalDir, { recursive: true });
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        globalPath,
        JSON.stringify(VALID_CONFIG, null, 2) + "\n",
        "utf-8",
      );
    });
  });

  // -----------------------------------------------------------------------
  // Valid JSON parsing
  // -----------------------------------------------------------------------
  describe("valid JSON parsing", () => {
    it("returns the parsed config object for a complete configuration", () => {
      const usableTestKey = "not-sensitive";
      const fullCfg = {
        providers: {
          anthropic: { adapter: "anthropic" as const, api_key: usableTestKey },
        },
        default_provider: "anthropic",
        default_model: "claude-sonnet-4-20250514",
        routing: { enabled: true },
        session: { ai_title: { enabled: true } },
        mcp_servers: {
          filesystem: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem"],
          },
        },
      };
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(fullCfg));

      const config = loadConfig("/full/config.json");

      expect(config).toEqual(fullCfg);
    });

    it("returns the parsed config object for an empty JSON object", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("{}");

      const config = loadConfig();

      expect(config).toEqual({});
    });
  });

  // -----------------------------------------------------------------------
  // Invalid JSON → ConfigError
  // -----------------------------------------------------------------------
  describe("invalid JSON", () => {
    it("throws ConfigError when file contains malformed JSON", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("{ invalid json !!! }");

      expect(() => loadConfig("/bad/config.json")).toThrow(ConfigError);
    });

    it("throws ConfigError when file contains trailing comma", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('{ "key": "value", }');

      expect(() => loadConfig()).toThrow(ConfigError);
    });

    it("includes the file path in the error message", () => {
      const filePath = `${process.cwd()}/.vera/settings.json`;
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("not json");

      try {
        loadConfig();
        expect.fail("Expected loadConfig to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).message).toContain(filePath);
        expect((err as ConfigError).message).toContain("Failed to parse config");
      }
    });

    it("has code CONFIG_ERROR", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("bad");

      try {
        loadConfig();
        expect.fail("Expected loadConfig to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).code).toBe("CONFIG_ERROR");
      }
    });

    it("preserves the original error as cause", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("garbage");

      try {
        loadConfig();
        expect.fail("Expected loadConfig to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).cause).toBeDefined();
        expect((err as ConfigError).cause).toBeInstanceOf(SyntaxError);
      }
    });
  });

  // -----------------------------------------------------------------------
  // readFileSync error other than ENOENT
  // -----------------------------------------------------------------------
  describe("readFileSync non-ENOENT errors", () => {
    it("throws ConfigError when readFileSync fails with a permission error", () => {
      // existsSync says the file exists, but readFileSync fails (e.g., EACCES)
      const permissionError = new Error("EACCES: permission denied, open '/root/.vera/settings.json'");
      (permissionError as NodeJS.ErrnoException).code = "EACCES";

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation(() => {
        throw permissionError;
      });

      expect(() => loadConfig("/root/.vera/settings.json")).toThrow(ConfigError);
    });

    it("preserves the readFileSync error as the cause of ConfigError", () => {
      const permissionError = new Error("EACCES: permission denied");
      (permissionError as NodeJS.ErrnoException).code = "EACCES";

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation(() => {
        throw permissionError;
      });

      try {
        loadConfig();
        expect.fail("Expected loadConfig to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).cause).toBe(permissionError);
      }
    });
  });
});
