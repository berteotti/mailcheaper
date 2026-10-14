"use client";

import { useState } from "react";
import Image from "next/image";
import { ImagePlus, Loader2 } from "lucide-react";
import { toast } from "sonner";
import DialogImagePicker, { CHECKERBOARD } from "@/components/DialogImagePicker";
import { Button } from "@/components/ui/button";
import { uploadImageFile } from "@/lib/upload-image";
import { useImageDrop } from "@/lib/use-image-drop";
import { cn } from "@/lib/utils";

// An image setting: drop a file on it, or open the picker to upload one or reuse an earlier upload. The URL
// goes with the form under name. isRound: a person's photo, maybe Google's, which can fail to load with a referrer.
export default function InputImage({ name, defaultValue, label, isRound, onChange }) {
	const [url, setUrl] = useState(defaultValue ?? "");
	const [isPickerOpen, setIsPickerOpen] = useState(false);
	const [isUploading, setIsUploading] = useState(false);
	const { isDragging, dropProps } = useImageDrop(upload);

	function update(value) {
		setUrl(value);
		onChange?.(value);
	}

	async function upload(file) {
		if (isUploading) return;
		setIsUploading(true);
		try {
			update((await uploadImageFile(file)).url);
		} catch (error) {
			toast.error(error.message);
		} finally {
			setIsUploading(false);
		}
	}

	return (
		<span
			{...dropProps}
			className={cn("-m-1.5 flex items-center gap-3 rounded-xl p-1.5 transition-colors duration-150", isDragging && "bg-muted")}
		>
			<button
				type="button"
				disabled={isUploading}
				aria-label={`${url ? "Change" : "Add"} ${label}`}
				onClick={() => setIsPickerOpen(true)}
				style={url ? CHECKERBOARD : undefined}
				className={cn(
					"group relative grid size-14 shrink-0 place-items-center overflow-hidden bg-muted shadow-border outline-none transition-[box-shadow,scale] duration-150 ease-out hover:shadow-border-hover focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.96]",
					isRound ? "rounded-full" : "rounded-lg",
					isDragging && "ring-2 ring-foreground/30"
				)}
			>
				{url ? (
					<Image src={url} alt="" fill unoptimized referrerPolicy="no-referrer" sizes="56px" className="object-cover" />
				) : (
					<ImagePlus className="size-5 text-muted-foreground transition-transform duration-200 ease-out group-hover:scale-110" />
				)}
				{isUploading && (
					<span className="absolute inset-0 grid place-items-center bg-background/70 backdrop-blur-[2px]">
						<Loader2 className="size-4 animate-spin" />
					</span>
				)}
			</button>
			<span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
				<Button type="button" variant="outline" size="sm" disabled={isUploading} onClick={() => setIsPickerOpen(true)}>
					{url ? "Change" : "Choose"}
				</Button>
				{url ? (
					<Button type="button" variant="ghost" size="sm" disabled={isUploading} onClick={() => update("")}>
						Remove
					</Button>
				) : (
					<span className="text-xs text-muted-foreground">{isDragging ? "Drop to upload" : "or drop a file here"}</span>
				)}
			</span>
			<input type="hidden" name={name} value={url} />
			<DialogImagePicker
				open={isPickerOpen}
				onOpenChange={setIsPickerOpen}
				currentUrl={url}
				onSelect={(image) => update(image.url)}
			/>
		</span>
	);
}
