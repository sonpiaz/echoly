// Popup entrypoint — imports the bundled styles and boots the passive renderer
// (applyState(state) in, runtime messages out via @/shared/protocol).
import "./style.css";
import { initPopup } from "@/popup";

initPopup();
