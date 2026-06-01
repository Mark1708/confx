import { readFile } from "node:fs/promises";
import path from "node:path";

const fixtureRoot = path.resolve(process.cwd(), "tests/fixtures");

function resolveFixturePath(relativePath: string): string {
  const resolvedPath = path.resolve(fixtureRoot, relativePath);

  if (resolvedPath !== fixtureRoot && !resolvedPath.startsWith(`${fixtureRoot}${path.sep}`)) {
    throw new Error(`Fixture path escapes tests/fixtures: ${relativePath}`);
  }

  return resolvedPath;
}

export function fixturePath(relativePath: string): string {
  return resolveFixturePath(relativePath);
}

export async function readFixtureText(relativePath: string): Promise<string> {
  return readFile(resolveFixturePath(relativePath), "utf8");
}
