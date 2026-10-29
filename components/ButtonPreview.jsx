"use client";

import { useRef, useState } from "react";
import { Maximize2 } from "lucide-react";
import DialogPreviewEmail from "@/components/DialogPreviewEmail";
import { Button } from "@/components/ui/button";

// Opens an inline preview's email full screen, in a mail app's window or in Gmail on a phone (DialogPreviewEmail, which
// takes the other props), and gives the focus back to the button after.
export default function ButtonPreview(email) {
	const [isOpen, setIsOpen] = useState(false);
	const buttonRef = useRef(null);

	return (
		<>
			<Button ref={buttonRef} type="button" variant="ghost" size="sm" onClick={() => setIsOpen(true)}>
				<Maximize2 data-icon="inline-start" />
				Preview
			</Button>
			<DialogPreviewEmail
				{...email}
				isOpen={isOpen}
				onOpenChange={setIsOpen}
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					buttonRef.current?.focus();
				}}
			/>
		</>
	);
}
