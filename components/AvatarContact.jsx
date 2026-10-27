// name: the contact's, whose first letter shows instead of the email's.
export default function AvatarContact({ email, name, colorHash, size = 24 }) {
	const hue = Math.round((Number.parseInt(colorHash.slice(0, 4), 16) / 0xffff) * 360);

	return (
		<span
			aria-hidden="true"
			style={{
				width: size,
				height: size,
				fontSize: Math.round(size * 0.42),
				backgroundImage: `linear-gradient(135deg, oklch(0.78 0.11 ${hue}), oklch(0.62 0.14 ${hue + 40}))`,
			}}
			className="relative grid shrink-0 place-items-center overflow-hidden rounded-full font-semibold text-white uppercase outline -outline-offset-1 outline-black/5 dark:outline-white/10"
		>
			{(name || email).charAt(0)}
		</span>
	);
}
