import "dotenv/config";
import { runDueJobs } from "../src/services/jobs";
runDueJobs(process.argv.includes("--force")).then((r) => { console.log(r); process.exit(0); });
