import { headers } from 'next/headers';
import { getTTSState, startPreflight } from '@/lib/preflight';
import { clearModelAvailable } from '@/lib/enhance';

export async function GET() {
  await headers(); // forces dynamic rendering (never prerender a snapshot)
  startPreflight(); // keeps the daemon resident; piggybacks while it is loading
  return Response.json({ ...getTTSState(), clear: clearModelAvailable() });
}
