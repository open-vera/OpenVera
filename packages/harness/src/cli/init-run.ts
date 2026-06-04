import { resolve } from "node:path";
import { isConfigEmpty, loadConfig, runSetupWizard } from "@open-vera/core/config";

export interface InitRunArgs {
  dir?: string;
  force?: boolean;
}

export async function runInitCommand(args: InitRunArgs): Promise<void> {
  const cwd = resolve(args.dir ?? ".");
  const config = loadConfig(undefined, cwd);

  if (!args.force && !isConfigEmpty(config)) {
    process.stderr.write("OpenVera is already configured. Use `openvera init --force` to run setup again.\n");
    return;
  }

  if (!process.stdin.isTTY) {
    process.stderr.write("OpenVera init requires an interactive terminal.\n");
    process.exit(1);
  }

  const selectedProvider = await runSetupWizard(cwd);
  if (!selectedProvider) process.exit(1);
}
