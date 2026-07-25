declare module "@parcel/watcher/wrapper" {
  export const createWrapper: (binding: unknown) => typeof import("@parcel/watcher")
}
