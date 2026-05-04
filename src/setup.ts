#!/usr/bin/env node
import { createInterface } from "node:readline";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import {
  existsSync,
  lstatSync,
  readlinkSync,
  readdirSync,
  mkdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  copyFileSync,
} from "node:fs";

const MEMORY_DIR = join(homedir(), ".agent-memory");
const DB_FILE = "memory.db";

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

function getCloudStoragePath(): string {
  return join(homedir(), "Library", "CloudStorage");
}

function findGoogleDriveAccounts(): { email: string; path: string }[] {
  const cloudStorage = getCloudStoragePath();
  if (!existsSync(cloudStorage)) return [];

  return readdirSync(cloudStorage)
    .filter((entry) => entry.startsWith("GoogleDrive-"))
    .map((entry) => ({
      email: entry.replace("GoogleDrive-", "").replace(/ \(.*\)$/, ""),
      path: join(cloudStorage, entry, "My Drive"),
    }))
    .filter((account) => existsSync(account.path));
}

function getCurrentSetup(): { type: "symlink"; target: string } | { type: "local" } | { type: "none" } {
  if (!existsSync(MEMORY_DIR) && !isSymlink(MEMORY_DIR)) return { type: "none" };
  if (isSymlink(MEMORY_DIR)) {
    return { type: "symlink", target: readlinkSync(MEMORY_DIR) };
  }
  return { type: "local" };
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

async function setupGoogleDrive(accounts: { email: string; path: string }[]): Promise<void> {
  let selectedAccount: { email: string; path: string };

  if (accounts.length === 1) {
    selectedAccount = accounts[0];
    console.log(`\nFound Google Drive account: ${selectedAccount.email}`);
  } else {
    console.log("\nAvailable Google Drive accounts:");
    accounts.forEach((account, i) => {
      console.log(`  ${i + 1}. ${account.email}`);
    });
    const choice = await ask("\nSelect account number: ");
    const index = parseInt(choice, 10) - 1;
    if (index < 0 || index >= accounts.length) {
      console.log("Invalid selection. Aborting.");
      return;
    }
    selectedAccount = accounts[index];
  }

  const driveMemoryDir = join(selectedAccount.path, "agent-memory");

  mkdirSync(driveMemoryDir, { recursive: true });

  const currentSetup = getCurrentSetup();

  if (currentSetup.type === "local") {
    const existingDb = join(MEMORY_DIR, DB_FILE);
    if (existsSync(existingDb)) {
      const driveDb = join(driveMemoryDir, DB_FILE);
      if (existsSync(driveDb)) {
        const overwrite = await ask(
          "\nA database already exists in Google Drive. Overwrite with local copy? (y/N): "
        );
        if (overwrite.toLowerCase() !== "y") {
          console.log("Keeping Google Drive version.");
        } else {
          copyFileSync(existingDb, driveDb);
          console.log("Copied local database to Google Drive.");
        }
      } else {
        renameSync(existingDb, join(driveMemoryDir, DB_FILE));
        console.log("Moved local database to Google Drive.");
      }
    }

    cleanDirectory(MEMORY_DIR);
  } else if (currentSetup.type === "symlink") {
    unlinkSync(MEMORY_DIR);
  }

  symlinkSync(driveMemoryDir, MEMORY_DIR);
  console.log(`\nDone! ~/.agent-memory -> ${driveMemoryDir}`);
  console.log("Your memory database will now sync via Google Drive.");
}

function cleanDirectory(dir: string): void {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    try {
      unlinkSync(fullPath);
    } catch {
      // skip directories or locked files
    }
  }
  try {
    const { rmdirSync } = require("node:fs");
    rmdirSync(dir);
  } catch {
    // if dir not empty, remove it forcefully
    const { rmSync } = require("node:fs");
    rmSync(dir, { recursive: true, force: true });
  }
}

async function setupLocal(): Promise<void> {
  const currentSetup = getCurrentSetup();

  if (currentSetup.type === "symlink") {
    const target = readlinkSync(MEMORY_DIR);
    const driveDb = join(target, DB_FILE);

    unlinkSync(MEMORY_DIR);
    mkdirSync(MEMORY_DIR, { recursive: true });

    if (existsSync(driveDb)) {
      copyFileSync(driveDb, join(MEMORY_DIR, DB_FILE));
      console.log("Copied database from Google Drive to local storage.");
    }
  } else {
    mkdirSync(MEMORY_DIR, { recursive: true });
  }

  console.log(`\nDone! Data will be stored locally at ${MEMORY_DIR}`);
}

async function main(): Promise<void> {
  console.log("=== Agent Memory Setup ===\n");

  const currentSetup = getCurrentSetup();
  if (currentSetup.type === "symlink") {
    console.log(`Current: Google Drive backup (-> ${currentSetup.target})`);
  } else if (currentSetup.type === "local") {
    console.log(`Current: Local storage (${MEMORY_DIR})`);
  } else {
    console.log("Current: Not configured yet");
  }

  if (platform() !== "darwin") {
    console.log("\nGoogle Drive Desktop symlink is only supported on macOS.");
    console.log("Setting up local storage...");
    await setupLocal();
    rl.close();
    return;
  }

  const accounts = findGoogleDriveAccounts();

  if (accounts.length === 0) {
    console.log("\nNo Google Drive Desktop installation found.");
    console.log("Setting up local storage...");
    await setupLocal();
    rl.close();
    return;
  }

  const choice = await ask(
    "\nBackup to Google Drive? (y/N): "
  );

  if (choice.toLowerCase() === "y") {
    await setupGoogleDrive(accounts);
  } else {
    await setupLocal();
  }

  rl.close();
}

main().catch((error) => {
  console.error(`Setup failed: ${error}`);
  rl.close();
  process.exit(1);
});
