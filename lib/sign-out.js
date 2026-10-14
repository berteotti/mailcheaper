// Every way to sign out asks first: the buttons (ButtonSignout) and the account menu (MenuUser).
export function askToSignOut() {
	return window.confirm("Sign out of MailCheap?");
}
