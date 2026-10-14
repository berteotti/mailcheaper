import { useState } from "react";

// Highlights a drop target while files are dragged over it, and hands over the first file dropped. React
// bubbles events from portals (a dialog opened from inside) up to the target too, so only its own DOM counts.
export function useImageDrop(onFile) {
	const [isDragging, setIsDragging] = useState(false);

	function isFileDragInside(event) {
		return event.currentTarget.contains(event.target) && event.dataTransfer.types.includes("Files");
	}

	return {
		isDragging,
		dropProps: {
			onDragOver(event) {
				if (!isFileDragInside(event)) return;
				event.preventDefault();
				setIsDragging(true);
			},
			onDragLeave(event) {
				if (!event.currentTarget.contains(event.relatedTarget)) setIsDragging(false);
			},
			onDrop(event) {
				if (!isFileDragInside(event)) return;
				event.preventDefault();
				setIsDragging(false);
				if (event.dataTransfer.files.length > 0) onFile(event.dataTransfer.files[0]);
			},
		},
	};
}
