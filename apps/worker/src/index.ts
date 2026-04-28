console.log("worker booted");

process.on("SIGTERM", () => {
  console.log("worker received SIGTERM");
  process.exit(0);
});
