import { getTTSState, startPreflight } from '@/lib/preflight';
import { killDaemon } from '@/lib/ttsd';

export async function POST() {
  killDaemon(); // synchronous taskkill: the model leaves RAM/VRAM now
  startPreflight(); // fresh daemon; clearOrphans() runs before the spawn
  return Response.json(getTTSState());
}
