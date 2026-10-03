"use client";

import { LimitReachedNotice } from "@/components/billing/limit-reached-notice";
import { ReanalyzeDialog } from "@/components/projects/reanalyze-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createProjectFromZip,
  prepareZipUpload,
  startZipUpload,
  type ProjectActionState,
} from "@/lib/actions/github";
import { MAX_REPO_SIZE_BYTES, MAX_UPLOAD_BYTES, UPLOAD_TOO_BIG_MESSAGE } from "@/lib/limits";
import { startTransition, useActionState, useRef, useState, type FormEvent } from "react";

const initialState: ProjectActionState = {};

/**
 * `direct`: object storage is configured (ADR-011), so the browser sends
 * the ZIP straight to the bucket and the analysis workflow imports it (up to
 * 100 MB). Otherwise (local dev, CI) the ZIP goes through the request, which
 * Vercel caps at 4.5 MB (TD-45).
 */
export function ZipUploadForm({ direct = false }: { direct?: boolean }) {
  return direct ? <DirectZipUploadForm /> : <InRequestZipUploadForm />;
}

const MAX_DIRECT_MB = MAX_REPO_SIZE_BYTES / (1024 * 1024);

function DirectZipUploadForm() {
  const [state, setState] = useState<ProjectActionState>({});
  const [busy, setBusy] = useState<string | null>(null);
  // Kept for "Analyze again": the prompt comes before the file is sent.
  const pendingFile = useRef<File | null>(null);

  async function upload(file: File, confirmReanalyze: boolean) {
    setState({});
    // UX only: the server and the signed policy check the same rules.
    if (!file.name.toLowerCase().endsWith(".zip")) {
      setState({ error: "Only .zip uploads are supported." });
      return;
    }
    if (file.size > MAX_REPO_SIZE_BYTES) {
      setState({ error: `ZIP exceeds the ${MAX_DIRECT_MB} MB limit.` });
      return;
    }

    setBusy("Preparing…");
    const request = new FormData();
    request.set("fileName", file.name);
    request.set("size", String(file.size));
    if (confirmReanalyze) request.set("confirmReanalyze", "1");
    const plan = await prepareZipUpload(request);
    if (plan.duplicate) {
      pendingFile.current = file;
      setBusy(null);
      setState({ duplicate: plan.duplicate });
      return;
    }
    if (!plan.upload) {
      setBusy(null);
      setState({ error: plan.error ?? "Failed to prepare the upload." });
      return;
    }

    setBusy("Uploading…");
    const body = new FormData();
    for (const [field, value] of Object.entries(plan.upload.fields)) body.append(field, value);
    body.append("file", file); // the bucket expects the file last
    const sent = await fetch(plan.upload.url, { method: "POST", body }).then(
      (response) => response.ok,
      () => false,
    );
    if (!sent) {
      setBusy(null);
      setState({ error: "The upload failed. Please try again." });
      return;
    }

    setBusy("Starting analysis…");
    const start = new FormData();
    start.set("key", plan.upload.key);
    start.set("fileName", file.name);
    const result = await startZipUpload(start); // redirects to the progress page
    setBusy(null);
    setState(result);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("file");
    const file = input instanceof HTMLInputElement ? input.files?.[0] : undefined;
    if (file) void upload(file, false);
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <ReanalyzeDialog
        state={state}
        resubmit={() => {
          if (pendingFile.current) void upload(pendingFile.current, true);
        }}
      />
      <div className="space-y-2">
        <Label htmlFor="file">ZIP file</Label>
        <Input id="file" name="file" type="file" accept=".zip,application/zip" required />
        <p className="text-xs text-(--ca-muted)">
          Max {MAX_DIRECT_MB} MB. Only JavaScript/TypeScript source files are analyzed.
        </p>
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      {state.limit ? <LimitReachedNotice limit={state.limit} /> : null}
      <Button type="submit" disabled={busy !== null}>
        {busy ?? "Upload and analyze"}
      </Button>
    </form>
  );
}

function InRequestZipUploadForm() {
  // React resets the form after its action runs, emptying the file input:
  // "Analyze again" re-sends the last submission instead of the form.
  const lastSubmission = useRef<FormData | null>(null);
  const [state, formAction, pending] = useActionState(
    (previous: ProjectActionState, formData: FormData) => {
      lastSubmission.current = formData;
      return createProjectFromZip(previous, formData);
    },
    initialState,
  );

  // A ZIP over the limit never reaches the server on Vercel (TD-45): stop it
  // here so the user gets a reason, not the platform's 413. The server
  // checks the same limit.
  const [tooBig, setTooBig] = useState(false);
  function checkSize(event: FormEvent<HTMLFormElement>) {
    const input = event.currentTarget.elements.namedItem("file");
    const file = input instanceof HTMLInputElement ? input.files?.[0] : undefined;
    const over = Boolean(file && file.size > MAX_UPLOAD_BYTES);
    setTooBig(over);
    if (over) event.preventDefault();
  }

  function analyzeAgain() {
    const last = lastSubmission.current;
    if (!last) return;
    const again = new FormData();
    for (const [key, value] of last) again.append(key, value);
    again.set("confirmReanalyze", "1");
    startTransition(() => formAction(again));
  }

  return (
    <form action={formAction} onSubmit={checkSize} className="space-y-4">
      <ReanalyzeDialog state={state} resubmit={analyzeAgain} />
      <div className="space-y-2">
        <Label htmlFor="file">ZIP file</Label>
        <Input
          id="file"
          name="file"
          type="file"
          accept=".zip,application/zip"
          required
          onChange={() => setTooBig(false)}
        />
        <p className="text-xs text-(--ca-muted)">
          Max 4 MB. For a bigger project, import it from GitHub. Only
          JavaScript/TypeScript source files are analyzed.
        </p>
      </div>
      {tooBig || state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {tooBig ? UPLOAD_TOO_BIG_MESSAGE : state.error}
        </p>
      ) : null}
      {state.limit ? <LimitReachedNotice limit={state.limit} /> : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Uploading..." : "Upload and analyze"}
      </Button>
    </form>
  );
}
