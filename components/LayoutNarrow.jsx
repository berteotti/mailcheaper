// Settings-like pages: a column narrower than the dashboard's, on the same center line.
export default function LayoutNarrow({ children }) {
	return <div className="mx-auto w-full max-w-3xl">{children}</div>;
}
