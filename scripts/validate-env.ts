import { ConfigValidationError, loadRuntimeConfig } from "@repo/config";

try {
  loadRuntimeConfig();
  console.log("environment looks valid");
} catch (error: unknown) {
  if (error instanceof ConfigValidationError) {
    console.error(error.message);
    process.exit(1);
  }

  console.error(error);
  process.exit(1);
}
