"use client";

import { useActionState, useState } from "react";
import { ArrowLeft, ArrowRight, Loader2 } from "lucide-react";
import { signOut } from "@/app/signin/actions";
import { completeOnboarding } from "@/app/welcome/actions";
import ButtonSignout from "@/components/ButtonSignout";
import LayoutSplit from "@/components/LayoutSplit";
import LogoWordmark from "@/components/LogoWordmark";
import PreviewNewsletter from "@/components/PreviewNewsletter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MAX_DESCRIPTION_LENGTH } from "@/lib/newsletters";
import { slugify } from "@/lib/slug";
import { cn } from "@/lib/utils";

// A new account's first stop: a few questions that need no DNS or verification, one at a time, with the
// newsletter taking shape on the right. The last one sends everything; the earlier ones only move on.
// image: the user's picture (Google sign-in's), which the preview shows as the sender's.
export default function FormOnboarding({ defaultFromName, image, sharedDomain, listSizes, listSources }) {
	const [state, action, isPending] = useActionState(completeOnboarding, null);
	const [step, setStep] = useState(0);
	const [values, setValues] = useState({ name: "", description: "", fromName: defaultFromName, listSize: "" });
	const current = STEPS[step];
	const isLast = step === STEPS.length - 1;
	const address = `hello@${slugify(values.name) || "your-newsletter"}.${sharedDomain}`;

	function update(key) {
		return (event) => setValues((previous) => ({ ...previous, [key]: event.target.value }));
	}

	function onSubmit(event) {
		if (isLast) return;
		event.preventDefault();
		setStep(step + 1);
	}

	return (
		<LayoutSplit aside={<PreviewNewsletter {...values} image={image} address={address} activeField={current.key} />}>
			<header className="flex h-9 items-center justify-between gap-3">
				<LogoWordmark />
				<form action={signOut}>
					<ButtonSignout>Sign out</ButtonSignout>
				</form>
			</header>

			<div className="flex flex-1 items-center justify-center py-12">
				<form action={action} onSubmit={onSubmit} className="w-full max-w-md">
					<input type="hidden" name="name" value={values.name} />
					<input type="hidden" name="description" value={values.description} />
					<input type="hidden" name="fromName" value={values.fromName} />

					<div className="flex items-center gap-3">
						<button
							type="button"
							onClick={() => setStep(step - 1)}
							disabled={step === 0}
							aria-label="Back"
							className="-ml-2 grid size-8 place-items-center rounded-lg text-muted-foreground transition-[color,background-color,opacity] duration-150 hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-0"
						>
							<ArrowLeft className="size-4" />
						</button>
						<ol aria-label={`Step ${step + 1} of ${STEPS.length}`} className="flex flex-1 gap-1.5">
							{STEPS.map(({ key }, index) => (
								<li key={key} className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
									<span
										className={cn(
											"block h-full origin-left rounded-full bg-foreground transition-transform duration-500 ease-[cubic-bezier(0.2,0,0,1)]",
											index <= step ? "scale-x-100" : "scale-x-0"
										)}
									/>
								</li>
							))}
						</ol>
					</div>

					<div key={current.key} className="mt-10 animate-enter">
						<h1 className="font-display text-[2.25rem] leading-[1.08] font-[480] tracking-[-0.03em] text-balance">{current.title}</h1>
						<p className="mt-3 text-[15px] leading-6 text-pretty text-muted-foreground">{current.hint}</p>

						<div className="mt-8">
							{current.key === "name" && (
								<>
									<Input
										value={values.name}
										onChange={update("name")}
										placeholder="Field notes"
										aria-label="Newsletter name"
										maxLength={100}
										required
										autoFocus
										className="h-12 text-lg md:text-lg"
									/>
									<p className="mt-3 truncate text-sm text-muted-foreground">
										It sends from <span className="font-medium text-foreground">{address}</span>
									</p>
								</>
							)}
							{current.key === "description" && (
								<>
									<Input
										value={values.description}
										onChange={update("description")}
										placeholder="One idea about building things, every Sunday."
										aria-label="What it's about"
										maxLength={MAX_DESCRIPTION_LENGTH}
										autoFocus
										className="h-12 text-lg md:text-lg"
									/>
									<p className="mt-3 text-right text-xs text-muted-foreground tabular-nums">
										{values.description.length}/{MAX_DESCRIPTION_LENGTH}
									</p>
								</>
							)}
							{current.key === "fromName" && (
								<Input
									value={values.fromName}
									onChange={update("fromName")}
									placeholder="Jane"
									aria-label="Sender name"
									maxLength={100}
									autoFocus
									className="h-12 text-lg md:text-lg"
								/>
							)}
							{current.key === "list" && (
								<div className="flex flex-col gap-7">
									<fieldset className="grid grid-cols-2 gap-2">
										<legend className="sr-only">Subscribers</legend>
										{listSizes.map(({ id, label }) => (
											<OptionChoice
												key={id}
												name="listSize"
												value={id}
												label={label}
												checked={values.listSize === id}
												onChange={update("listSize")}
												required
											/>
										))}
									</fieldset>
									{values.listSize && values.listSize !== "none" && (
										<fieldset className="flex flex-col gap-3 animate-enter">
											<legend className="mb-3 text-sm font-medium">Where are they now?</legend>
											<div className="flex flex-wrap gap-2">
												{listSources.map((source) => (
													<OptionChoice key={source} name="listSource" value={source} label={source} isCompact />
												))}
											</div>
										</fieldset>
									)}
								</div>
							)}
						</div>
					</div>

					{state?.error && (
						<p role="alert" className="mt-5 text-sm text-pretty text-destructive">
							{state.error}
						</p>
					)}
					<div className="mt-8 flex items-center gap-2">
						<Button type="submit" size="lg" disabled={isPending} className="h-11 min-w-36 px-5 text-[15px]">
							{isPending ? <Loader2 className="animate-spin" /> : isLast ? "Create newsletter" : "Continue"}
							{!isPending && <ArrowRight data-icon="inline-end" />}
						</Button>
						{current.isOptional && (
							<Button type="button" variant="ghost" size="lg" onClick={() => setStep(step + 1)} className="h-11 text-muted-foreground">
								Skip
							</Button>
						)}
					</div>
				</form>
			</div>
		</LayoutSplit>
	);
}

function OptionChoice({ name, value, label, checked, onChange, required, isCompact }) {
	return (
		<label
			className={cn(
				"flex cursor-pointer items-center rounded-xl text-sm font-medium shadow-border transition-[box-shadow,background-color,color] duration-150 select-none hover:bg-muted/60 has-checked:bg-foreground has-checked:text-background has-checked:shadow-none has-focus-visible:ring-3 has-focus-visible:ring-ring/50",
				isCompact ? "h-9 px-3.5" : "h-12 px-4"
			)}
		>
			<input type="radio" name={name} value={value} checked={checked} onChange={onChange} required={required} className="sr-only" />
			{label}
		</label>
	);
}

const STEPS = [
	{ key: "name", title: "What's your newsletter called?", hint: "You can change it later." },
	{ key: "description", title: "What's it about?", hint: "One line, under its name on your signup form and archive.", isOptional: true },
	{ key: "fromName", title: "Who's it from?", hint: "The name your readers see in their inbox." },
	{ key: "list", title: "Do you have subscribers already?", hint: "MailCheap suggests the plan that fits. You import them later." },
];
