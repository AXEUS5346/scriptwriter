import { Suspense } from 'react';
import EditorClient from './editor-client';

export default function EditorPage() {
  return (
    <Suspense
      fallback={
        <main className="flex h-dvh flex-1 items-center justify-center text-sm text-muted-foreground">
          Loading script…
        </main>
      }
    >
      <EditorClient />
    </Suspense>
  );
}
