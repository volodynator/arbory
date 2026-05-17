/// <reference types="vite/client" />

interface StorageManager {
	getDirectory?: () => Promise<FileSystemDirectoryHandle>;
}
