import { execaSync } from "execa";

export async function setup() {
  execaSync("npm", ["run", "build"], { stdio: "inherit" });
}
