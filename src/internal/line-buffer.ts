export class LineBuffer {
	private fragments: string[] = [];
	private size = 0;

	public get length(): number {
		return this.size;
	}

	public get contentLength(): number {
		return this.size - (this.fragments.at(-1)?.endsWith('\r') ? 1 : 0);
	}

	public append(fragment: string): void {
		if (fragment.length > 0) {
			this.fragments.push(fragment);
			this.size += fragment.length;
		}
	}

	public take(fragment: string, terminated: boolean = true): string {
		let line = fragment;
		if (this.fragments.length > 0) {
			this.fragments.push(fragment);
			line = this.fragments.join('');
			this.fragments.length = 0;
			this.size = 0;
		}

		return terminated && line.endsWith('\r') ? line.slice(0, -1) : line;
	}
}
