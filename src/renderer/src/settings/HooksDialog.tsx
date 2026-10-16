import { useEffect, useState } from "react";
import { CircleAlert, CircleCheck } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Bridge, type HookPreview } from "@/island/core/bridge";

interface Props {
  /** Which change is being reviewed; null keeps the dialog closed. */
  mode: "install" | "remove" | null;
  onClose(): void;
  onApplied(): void;
}

const message = (err: unknown) => String(err instanceof Error ? err.message : err);

/**
 * The diff is the point of this dialog: nothing reaches settings.json until the
 * exact change has been on screen and the button under it has been clicked.
 */
export function HooksDialog({ mode, onClose, onApplied }: Props) {
  const [preview, setPreview] = useState<HookPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [backup, setBackup] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);

  useEffect(() => {
    setPreview(null);
    setError(null);
    setBackup(null);
    if (!mode) return;
    let stale = false;
    Bridge.hooksPreview(mode === "install").then(
      (p) => !stale && setPreview(p),
      (err) => !stale && setError(message(err)),
    );
    return () => {
      stale = true;
    };
  }, [mode]);

  const apply = async () => {
    if (!mode || !preview) return;
    setWriting(true);
    setError(null);
    try {
      setBackup(await Bridge.hooksApply(mode === "install", preview.fingerprint));
      onApplied();
    } catch (err) {
      setError(message(err));
      // The file moved under us: show what it looks like now.
      Bridge.hooksPreview(mode === "install").then(setPreview, () => {});
    } finally {
      setWriting(false);
    }
  };

  const installing = mode === "install";
  const noChange = preview?.diff.trim() === "No change.";

  return (
    <Dialog open={mode != null} onOpenChange={(open) => !open && onClose()}>
      {/* A column that never grows past the window: header and footer stay put,
          the diff in between scrolls both ways. The default grid layout let a
          long diff line widen the whole dialog until its buttons were off-screen. */}
      <DialogContent className="flex max-h-[calc(100vh-2rem)] flex-col sm:max-w-2xl">
        <DialogHeader className="shrink-0 pr-6">
          <DialogTitle>{installing ? "Install Claude Code hooks" : "Remove Claude Code hooks"}</DialogTitle>
          <DialogDescription>
            {installing
              ? "This is the exact change to your Claude Code settings. Lines starting with + are added."
              : "Only Poupou's own entries are removed. Lines starting with - are deleted."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
        {backup != null ? (
          <Alert>
            <CircleCheck />
            <AlertTitle>{installing ? "Hooks installed" : "Hooks removed"}</AlertTitle>
            <AlertDescription>
              <p>
                {installing
                  ? "New Claude Code sessions will show up on the island. Sessions already open need a restart."
                  : "Claude Code no longer talks to Poupou."}
              </p>
              <p className="font-mono text-[11px] break-all">Backup: {backup}</p>
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {error && (
              <Alert variant="destructive">
                <CircleAlert />
                <AlertTitle>Nothing was written</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {preview && (
              <>
                <div className="min-h-32 min-w-0 flex-1 overflow-auto rounded-md border bg-background">
                  <pre className="w-max min-w-full p-3 font-mono text-[11px] leading-relaxed select-text">
                    {preview.diff.split("\n").map((line, i) => (
                      <div
                        key={i}
                        className={
                          line.startsWith("+")
                            ? "bg-emerald-500/10 text-emerald-300"
                            : line.startsWith("-")
                              ? "bg-red-500/10 text-red-300"
                              : "text-muted-foreground"
                        }
                      >
                        {line || " "}
                      </div>
                    ))}
                  </pre>
                </div>
                <div className="shrink-0 space-y-1 font-mono text-[11px] text-muted-foreground">
                  <p className="break-all">File: {preview.settingsPath}</p>
                  <p className="break-all">Backup: {preview.backup}</p>
                </div>
              </>
            )}
            {!preview && !error && <p className="text-sm text-muted-foreground">Reading your settings…</p>}
          </>
        )}
        </div>

        <DialogFooter className="shrink-0 flex-row justify-end">
          {backup != null ? (
            <Button onClick={onClose}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button
                variant={installing ? "default" : "destructive"}
                disabled={!preview || writing || noChange}
                onClick={apply}
              >
                {noChange ? "Nothing to change" : installing ? "Write settings.json" : "Remove from settings.json"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
