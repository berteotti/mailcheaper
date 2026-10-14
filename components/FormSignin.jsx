"use client";

import { useActionState, useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { sendSigninCode, verifySigninCode } from "@/app/signin/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// oauthQuery: the authorization request of an app connecting with OAuth, resumed once the code checks out.
export default function FormSignin({ next, oauthQuery }) {
	const [sent, sendAction, isSending] = useActionState(sendSigninCode, null);
	const [checked, verifyAction, isVerifying] = useActionState(verifySigninCode, null);
	const [dismissed, setDismissed] = useState(null);
	const email = sent?.email && sent !== dismissed ? sent.email : null;

	if (!email) {
		return (
			<form action={sendAction} data-goal="signup_started" className="flex flex-col gap-3">
				<Input
					name="email"
					type="email"
					placeholder="Email"
					autoComplete="email"
					defaultValue={dismissed?.email}
					required
					autoFocus
					className="h-11"
				/>
				{sent?.error && <p className="text-sm text-destructive">{sent.error}</p>}
				<Button type="submit" size="lg" disabled={isSending} className="mt-1 h-11">
					{isSending ? <Loader2 className="animate-spin" /> : "Email me a code"}
					{!isSending && <ArrowRight data-icon="inline-end" />}
				</Button>
			</form>
		);
	}

	return (
		<div className="flex flex-col gap-4">
			<form action={verifyAction} className="flex flex-col gap-3">
				<input type="hidden" name="email" value={email} />
				<input type="hidden" name="next" value={next} />
				{oauthQuery && <input type="hidden" name="oauth_query" value={oauthQuery} />}
				<p className="text-sm text-pretty text-muted-foreground">
					Enter the code sent to <span className="font-medium text-foreground">{email}</span>
				</p>
				<Input
					name="code"
					inputMode="numeric"
					autoComplete="one-time-code"
					placeholder="000000"
					maxLength={10}
					required
					autoFocus
					aria-label="Code"
					className="h-11 text-center font-mono text-lg tracking-[0.4em] tabular-nums"
				/>
				{checked?.error && <p className="text-sm text-destructive">{checked.error}</p>}
				<Button type="submit" size="lg" disabled={isVerifying} className="h-11">
					{isVerifying ? <Loader2 className="animate-spin" /> : "Sign in"}
				</Button>
			</form>
			<div className="flex items-center justify-between gap-3 text-sm">
				<button
					type="button"
					onClick={() => setDismissed(sent)}
					className="text-muted-foreground transition-colors duration-150 hover:text-foreground"
				>
					Use another email
				</button>
				<form action={sendAction}>
					<input type="hidden" name="email" value={email} />
					<button
						type="submit"
						disabled={isSending}
						className="text-muted-foreground transition-colors duration-150 hover:text-foreground disabled:opacity-50"
					>
						{isSending ? "Sending…" : "Send a new code"}
					</button>
				</form>
			</div>
		</div>
	);
}
