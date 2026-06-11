import cron from "node-cron";
import { runCycle } from "./cycle";

const runNow = process.argv.includes("--once");
if (runNow) {
  runCycle()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("[sync] cycle failed:", e);
      process.exit(1);
    });
} else {
  console.log("[sync] scheduler started (hourly)");
  const safeCycle = () => runCycle().catch((e) => console.error("[sync] cycle failed:", e));
  cron.schedule("0 * * * *", () => {
    void safeCycle();
  });
  void safeCycle();
}
