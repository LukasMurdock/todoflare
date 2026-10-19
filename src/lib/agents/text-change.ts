/** Splits two texts into what they share at each end and the words between that differ. */
export function textChange(before: string, after: string): { prefix: string; removed: string; added: string; suffix: string } {
	const left = before.split(/(\s+)/);
	const right = after.split(/(\s+)/);
	let start = 0;
	while (start < left.length && start < right.length && left[start] === right[start]) start++;
	let end = 0;
	while (end < left.length - start && end < right.length - start && left[left.length - 1 - end] === right[right.length - 1 - end]) end++;
	return {
		prefix: left.slice(0, start).join(""),
		removed: left.slice(start, left.length - end).join(""),
		added: right.slice(start, right.length - end).join(""),
		suffix: left.slice(left.length - end).join(""),
	};
}
