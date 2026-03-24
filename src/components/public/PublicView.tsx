import type { Value } from "platejs";
import { createSlateEditor } from "platejs";
import { KEYS } from "platejs";

import { EditorStatic } from "@/components/ui/editor-static";
import { usePublicColumnSync } from "@/hooks/useColumnSync";

interface PublicViewProps {
	publicId: string;
}

export function PublicView({ publicId }: PublicViewProps) {
	const { value, isLoading, error } = usePublicColumnSync(publicId);

	if (isLoading) {
		return (
			<div className="flex h-screen items-center justify-center">
				<div className="text-center">
					<div className="animate-spin h-8 w-8 border-2 border-primary border-t-transparent rounded-full mx-auto mb-4" />
					<p className="text-muted-foreground">Loading...</p>
				</div>
			</div>
		);
	}

	if (error) {
		return (
			<div className="flex h-screen items-center justify-center">
				<div className="text-center max-w-md">
					<h1 className="text-2xl font-bold mb-2">Unable to load</h1>
					<p className="text-muted-foreground mb-4">{error}</p>
					<a
						href="/"
						className="text-primary hover:underline"
					>
						Go to Todoflare
					</a>
				</div>
			</div>
		);
	}

	return (
		<div className="min-h-screen bg-background">
			{/* Header */}
			<header className="border-b border-border bg-muted/30 px-4 py-3">
				<div className="max-w-3xl mx-auto flex items-center justify-between">
					<div className="flex items-center gap-2">
						<span className="font-semibold">Todoflare</span>
						<span className="text-xs bg-muted px-2 py-0.5 rounded">
							Public View
						</span>
					</div>
					<a
						href="/"
						className="text-sm text-primary hover:underline"
					>
						Create your own
					</a>
				</div>
			</header>

			{/* Content */}
			<main className="max-w-3xl mx-auto px-4 py-8">
				<PublicEditor value={value} />
			</main>
		</div>
	);
}

function PublicEditor({ value }: { value: Value }) {
	const editor = createSlateEditor({
		value,
	});

	return (
		<EditorStatic
			editor={editor}
			className="prose prose-neutral dark:prose-invert max-w-none"
		/>
	);
}
