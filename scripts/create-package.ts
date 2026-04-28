import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const name = process.argv[2];

if (!name) {
  console.error("usage: bun run scripts/create-package.ts <name>");
  process.exit(1);
}

const dir = join(process.cwd(), "packages", name);
const packageName = `@repo/${name}`;

await mkdir(join(dir, "src"), { recursive: true });

await writeFile(
  join(dir, "src", "index.ts"),
  `export const packageName = ${JSON.stringify(packageName)} as const;\n`,
);

await writeFile(
  join(dir, "package.json"),
  `${JSON.stringify(
    {
      name: packageName,
      version: "0.0.0",
      private: true,
      type: "module",
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          import: "./dist/index.js",
        },
      },
      scripts: {
        build: "tsc -p tsconfig.build.json",
        typecheck: "tsc -p tsconfig.json --noEmit",
        test: "vitest run --passWithNoTests",
        lint: "biome check .",
        format: "biome format --write .",
        clean: "rm -rf dist .tsbuildinfo coverage",
      },
      dependencies: {},
      devDependencies: {
        typescript: "catalog:",
        vitest: "catalog:",
      },
    },
    null,
    2,
  )}\n`,
);

await writeFile(
  join(dir, "tsconfig.json"),
  `${JSON.stringify(
    {
      extends: "../../tsconfig.base.json",
      compilerOptions: {
        composite: true,
        noEmit: true,
        tsBuildInfoFile: "./.tsbuildinfo/typecheck.tsbuildinfo",
      },
      include: ["src/**/*.ts", "src/**/*.tsx", "test/**/*.ts"],
      exclude: ["dist", "node_modules"],
    },
    null,
    2,
  )}\n`,
);

await writeFile(
  join(dir, "tsconfig.build.json"),
  `${JSON.stringify(
    {
      extends: "./tsconfig.json",
      compilerOptions: {
        noEmit: false,
        declaration: true,
        declarationMap: true,
        emitDeclarationOnly: false,
        outDir: "dist",
        rootDir: "src",
        tsBuildInfoFile: "./.tsbuildinfo/build.tsbuildinfo",
      },
      include: ["src/**/*.ts"],
      exclude: ["dist", "node_modules", "test", "**/*.test.ts", "**/*.spec.ts"],
    },
    null,
    2,
  )}\n`,
);
