/** SCTP data-channel label for Echoly session metadata (transcripts, errors, usage). */
export const RTC_METADATA_CHANNEL = "echoly-events" as const;

export type RtcMetadataChannelLabel = typeof RTC_METADATA_CHANNEL;
