import { execa } from "execa";

let _cached: boolean | null = null;

export async function dockerAvailable(): Promise<boolean> {
  if (_cached !== null) return _cached;
  try {
    await execa("docker", ["info"], { timeout: 2000, all: true });
    _cached = true;
  } catch {
    _cached = false;
  }
  return _cached;
}
