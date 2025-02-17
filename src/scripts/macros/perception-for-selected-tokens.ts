import { CreaturePF2e } from "@actor";
import { TokenPF2e } from "@module/canvas";

export async function perceptionForSelected(event: JQuery.ClickEvent): Promise<void> {
    const actors = canvas.tokens.controlled
        .filter(
            (t): t is TokenPF2e & { actor: CreaturePF2e } =>
                !!t.actor && ["character", "npc", "familiar"].includes(t.actor.type)
        )
        .map((t) => t.actor);
    if (actors.length === 0) {
        ui.notifications.error("You must select at least one PC/NPC token.");
        return;
    }

    for (const actor of actors) {
        await actor.attributes.perception.roll({ event, options: ["secret"] });
    }
}
