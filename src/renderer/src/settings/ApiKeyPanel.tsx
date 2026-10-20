import { useCallback, useEffect, useState } from "react";
import { CircleAlert, KeyRound, Loader2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Bridge, type ApiKeyStatus } from "@/island/core/bridge";

const message = (err: unknown) => String(err instanceof Error ? err.message : err);

/**
 * Paste, check and store an Anthropic API key. The key goes to the main process
 * once and is never sent back here — only whether one is saved and its last
 * four characters.
 */
export function ApiKeyPanel() {
  const [status, setStatus] = useState<ApiKeyStatus | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => setStatus(await Bridge.apiKeyStatus()), []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await Bridge.apiKeySet(draft);
      setDraft("");
      await refresh();
    } catch (err) {
      setError(message(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    await Bridge.apiKeyClear();
    await refresh();
  };

  return (
    <div className="flex flex-col gap-3">
      {status?.present ? (
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="gap-1.5">
            <span className="size-1.5 rounded-full bg-emerald-400" />
            Key saved
          </Badge>
          <span className="font-mono text-xs text-muted-foreground">{status.hint}</span>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={remove}>
            Remove key
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Input
            type="password"
            placeholder="sk-ant-…"
            autoComplete="off"
            spellCheck={false}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && draft.trim() && void save()}
            className="font-mono text-xs"
          />
          <Button onClick={save} disabled={!draft.trim() || saving}>
            {saving ? <Loader2 className="animate-spin" /> : <KeyRound />}
            {saving ? "Checking…" : "Save key"}
          </Button>
        </div>
      )}

      {error && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>Key not saved</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <p className="text-xs text-muted-foreground">
        Create one at{" "}
        <button
          className="underline underline-offset-2 hover:text-foreground"
          onClick={() => void Bridge.openUrl("https://console.anthropic.com/settings/keys")}
        >
          console.anthropic.com
        </button>
        . It is checked with Anthropic, then stored encrypted by your operating system; usage is
        billed to your API account.{" "}
        {status?.engine === "cli"
          ? "Claude Code is installed, so the chat can still read files and run commands with your OK."
          : "Without Claude Code installed the chat answers and searches the web, but can't open files or run commands."}
      </p>
    </div>
  );
}
