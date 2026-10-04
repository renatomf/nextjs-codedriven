"use client";

import { useActionState, useState } from "react";

import { ActionAlert } from "@/components/shared/action-alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { deleteAccountAction, type DeleteAccountState } from "@/lib/actions/account";

/**
 * Deletes the account after the user types its email. The match is UX only:
 * the server compares it again with the session's own account.
 */
export function DeleteAccountForm({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [state, formAction, pending] = useActionState<DeleteAccountState, FormData>(
    deleteAccountAction,
    {},
  );
  const matches = typed.trim().toLowerCase() === email.toLowerCase();

  return (
    <>
      <Button type="button" variant="destructive" onClick={() => setOpen(true)}>
        Delete account
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (pending) return;
          setOpen(next);
          if (!next) setTyped("");
        }}
      >
        <DialogContent showCloseButton={!pending}>
          <DialogHeader className="gap-3">
            <p className="ca-kicker">Account</p>
            <DialogTitle>
              <span className="text-(--ca-muted)">Delete</span> your account?
            </DialogTitle>
            <DialogDescription>
              This deletes your projects, code, reports, share links and usage
              history, and cancels your subscription at once. It cannot be
              undone.
            </DialogDescription>
          </DialogHeader>

          <form action={formAction} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="delete-confirmation">
                Type <span className="font-mono">{email}</span> to confirm
              </Label>
              <Input
                id="delete-confirmation"
                name="confirmation"
                autoComplete="off"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                disabled={pending}
              />
            </div>

            {state.error ? <ActionAlert message={state.error} /> : null}

            <div className="grid gap-2 sm:grid-cols-2">
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" variant="destructive" disabled={!matches || pending}>
                {pending ? "Deleting…" : "Delete account"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
