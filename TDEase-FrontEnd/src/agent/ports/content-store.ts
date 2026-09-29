/** Reference persisted in an event when a tool result would be too large for JSONL. */
export interface ContentRef {
  content_ref: string
  media_type: string
  byte_length: number
}

/** The content store owns bytes; the session log only ever records ContentRef values. */
export interface ContentStore {
  putText(content: string, mediaType?: string): Promise<ContentRef>
  getText(ref: ContentRef): Promise<string>
}
