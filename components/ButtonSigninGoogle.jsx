import { signinWithGoogle } from "@/app/signin/actions";
import { Button } from "@/components/ui/button";

export default function ButtonSigninGoogle({ next, oauthQuery }) {
	return (
		<form action={signinWithGoogle} data-goal="signup_started">
			<input type="hidden" name="next" value={next} />
			{oauthQuery && <input type="hidden" name="oauth_query" value={oauthQuery} />}
			<Button type="submit" variant="outline" size="lg" className="h-11 w-full">
				<IconGoogle />
				Continue with Google
			</Button>
		</form>
	);
}

function IconGoogle() {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true">
			<path
				fill="#4285F4"
				d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.58-5.17 3.58-8.81Z"
			/>
			<path
				fill="#34A853"
				d="M12 24c3.24 0 5.96-1.07 7.94-2.92l-3.88-3c-1.07.72-2.45 1.15-4.06 1.15-3.13 0-5.78-2.11-6.72-4.95H1.27v3.1A12 12 0 0 0 12 24Z"
			/>
			<path
				fill="#FBBC05"
				d="M5.28 14.28a7.2 7.2 0 0 1 0-4.56v-3.1H1.27a12 12 0 0 0 0 10.76l4.01-3.1Z"
			/>
			<path
				fill="#EA4335"
				d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.44-3.44A11.97 11.97 0 0 0 12 0 12 12 0 0 0 1.27 6.62l4.01 3.1C6.22 6.88 8.87 4.77 12 4.77Z"
			/>
		</svg>
	);
}
