const required = ["DATABASE_URL", "REDIS_URL"] as const;

const missing = required.filter((key) => !process.env[key]);

if (missing.length > 0) {
  console.error(`Missing env vars: ${missing.join(", ")}`);
  process.exit(1);
}

console.log("environment looks valid");
