// Storage layout (TD-02): one prefix per video, `videos/{videoId}/`.
export function originalKey(videoId: string): string {
  return `videos/${videoId}/original`;
}

// Written by the video worker once processing succeeds (TD-06).
export function thumbnailKey(videoId: string): string {
  return `videos/${videoId}/thumbnail.jpg`;
}
