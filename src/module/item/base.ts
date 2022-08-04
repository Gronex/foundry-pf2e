import { ActorPF2e } from "@actor";
import { HazardSystemData } from "@actor/hazard/data";
import { ChatMessagePF2e } from "@module/chat-message";
import { preImportJSON } from "@module/doc-helpers";
import { MigrationList, MigrationRunner } from "@module/migration";
import { UserPF2e } from "@module/user";
import { DicePF2e } from "@scripts/dice";
import { EnrichHTMLOptionsPF2e } from "@system/text-editor";
import { ErrorPF2e, isObject, setHasElement, sluggify } from "@util";
import { RuleElementOptions, RuleElementPF2e, RuleElements, RuleElementSource } from "../rules";
import { ContainerPF2e } from "./container";
import { ItemDataPF2e, ItemSourcePF2e, ItemSummaryData, ItemType, TraitChatData } from "./data";
import { ItemTrait } from "./data/base";
import { isItemSystemData, isPhysicalData } from "./data/helpers";
import { MeleeSystemData } from "./melee/data";
import type { PhysicalItemPF2e } from "./physical";
import { PHYSICAL_ITEM_TYPES } from "./physical/values";
import { ItemSheetPF2e } from "./sheet/base";

interface ItemConstructionContextPF2e extends DocumentConstructionContext<ItemPF2e> {
    pf2e?: {
        ready?: boolean;
    };
}

/** Override and extend the basic :class:`Item` implementation */
class ItemPF2e extends Item<ActorPF2e> {
    /** Has this item gone through at least one cycle of data preparation? */
    private initialized?: true;

    /** Prepared rule elements from this item */
    rules!: RuleElementPF2e[];

    constructor(data: PreCreate<ItemSourcePF2e>, context: ItemConstructionContextPF2e = {}) {
        if (context.pf2e?.ready) {
            super(data, context);
        } else {
            context.pf2e = mergeObject(context.pf2e ?? {}, { ready: true });
            const ItemConstructor = CONFIG.PF2E.Item.documentClasses[data.type];
            return ItemConstructor ? new ItemConstructor(data, context) : new ItemPF2e(data, context);
        }
    }

    /** The sluggified name of the item **/
    get slug(): string | null {
        return this.system.slug;
    }

    /** The compendium source ID of the item **/
    get sourceId(): ItemUUID | null {
        return this.flags.core?.sourceId ?? null;
    }

    /** The recorded schema version of this item, updated after each data migration */
    get schemaVersion(): number | null {
        return Number(this.system.schema?.version) || null;
    }

    get description(): string {
        return this.system.description.value.trim();
    }

    /** Check this item's type (or whether it's one among multiple types) without a call to `instanceof` */
    isOfType(type: "physical"): this is PhysicalItemPF2e;
    isOfType<T extends ItemType>(...types: T[]): this is InstanceType<ConfigPF2e["PF2E"]["Item"]["documentClasses"][T]>;
    isOfType<T extends "physical" | ItemType>(
        ...types: T[]
    ): this is PhysicalItemPF2e | InstanceType<ConfigPF2e["PF2E"]["Item"]["documentClasses"][Exclude<T, "physical">]>;
    isOfType(...types: (ItemType | "physical")[]): boolean {
        return types.some((t) => (t === "physical" ? setHasElement(PHYSICAL_ITEM_TYPES, this.type) : this.type === t));
    }

    /** Redirect the deletion of any owned items to ActorPF2e#deleteEmbeddedDocuments for a single workflow */
    override async delete(context: DocumentModificationContext<this> = {}): Promise<this> {
        if (this.actor) {
            await this.actor.deleteEmbeddedDocuments("Item", [this.id], context);
            return this;
        }
        return super.delete(context);
    }

    /** Generate a list of strings for use in predication */
    getRollOptions(prefix = this.type): string[] {
        const slug = this.slug ?? sluggify(this.name);
        const traits: ItemTrait[] = this.system.traits?.value ?? [];
        const traitOptions = traits.map((t) => `trait:${t}`);
        const delimitedPrefix = prefix ? `${prefix}:` : "";
        const options = [
            `${delimitedPrefix}id:${this.id}`,
            `${delimitedPrefix}${slug}`,
            ...traitOptions.map((t) => `${delimitedPrefix}${t}`),
        ];

        if ("level" in this.system) options.push(`${delimitedPrefix}level:${this.system.level.value}`);
        if (["item", ""].includes(prefix)) {
            const itemType = this.isOfType("feat") && this.isFeature ? "feature" : this.type;
            options.unshift(`${delimitedPrefix}type:${itemType}`);
        }

        if (this.isOfType("consumable")) {
            options.push(`${delimitedPrefix}type:${this.consumableType}`);
        }

        return options;
    }

    override getRollData(): NonNullable<EnrichHTMLOptionsPF2e["rollData"]> {
        return { actor: this.actor, item: this };
    }

    /**
     * Create a chat card for this item and either return the message or send it to the chat log. Many cards contain
     * follow-up options for attack rolls, effect application, etc.
     */
    async toMessage(
        event?: JQuery.TriggeredEvent,
        {
            rollMode = undefined,
            create = true,
            data = {},
        }: { rollMode?: RollMode; create?: boolean; data?: Record<string, unknown> } = {}
    ): Promise<ChatMessagePF2e | undefined> {
        if (!this.actor) throw ErrorPF2e(`Cannot create message for unowned item ${this.name}`);

        // Basic template rendering data
        const template = `systems/pf2e/templates/chat/${this.type}-card.html`;
        const token = this.actor.token;
        const nearestItem = event ? event.currentTarget.closest(".item") : {};
        const contextualData = Object.keys(data).length > 0 ? data : nearestItem.dataset || {};
        const templateData = {
            actor: this.actor,
            tokenId: token ? `${token.parent?.id}.${token.id}` : null,
            item: this,
            data: await this.getChatData(undefined, contextualData),
        };

        // Basic chat message data
        const chatData: PreCreate<foundry.data.ChatMessageSource> = {
            speaker: ChatMessagePF2e.getSpeaker({
                actor: this.actor,
                token: this.actor.getActiveTokens()[0]?.document,
            }),
            flags: {
                core: {
                    canPopout: true,
                },
                pf2e: {
                    origin: { uuid: this.uuid, type: this.type },
                },
            },
            type: CONST.CHAT_MESSAGE_TYPES.OTHER,
        };

        // Toggle default roll mode
        rollMode ??= event?.ctrlKey || event?.metaKey ? "blindroll" : game.settings.get("core", "rollMode");
        if (["gmroll", "blindroll"].includes(rollMode))
            chatData.whisper = ChatMessagePF2e.getWhisperRecipients("GM").map((u) => u.id);
        if (rollMode === "blindroll") chatData.blind = true;

        // Render the template
        chatData.content = await renderTemplate(template, templateData);

        // Create the chat message
        return create ? ChatMessagePF2e.create(chatData, { renderSheet: false }) : new ChatMessagePF2e(chatData);
    }

    /** A shortcut to `item.toMessage(..., { create: true })`, kept for backward compatibility */
    async toChat(event?: JQuery.TriggeredEvent): Promise<ChatMessagePF2e | undefined> {
        return this.toMessage(event, { create: true });
    }

    protected override _initialize(): void {
        this.rules = [];
        super._initialize();
        this.initialized = true;
    }

    /** Refresh the Item Directory if this item isn't owned */
    override prepareData(): void {
        super.prepareData();
        if (!this.isOwned && ui.items && this.initialized) ui.items.render();
    }

    /** Ensure the presence of the pf2e flag scope with default properties and values */
    override prepareBaseData(): void {
        super.prepareBaseData();

        const { flags } = this;
        flags.pf2e = mergeObject(flags.pf2e ?? {}, { rulesSelections: {} });

        // Set item grant default values: pre-migration values will be strings, so temporarily check for objectness
        if (isObject(flags.pf2e.grantedBy)) {
            flags.pf2e.grantedBy.onDelete ??= this.isOfType("physical") ? "detach" : "cascade";
        }
        const grants = (flags.pf2e.itemGrants ??= []);
        for (const grant of grants) {
            if (isObject(grant)) grant.onDelete ??= "detach";
        }
    }

    prepareRuleElements(this: Embedded<ItemPF2e>, options?: RuleElementOptions): RuleElementPF2e[] {
        return (this.rules = this.actor.canHostRuleElements ? RuleElements.fromOwnedItem(this, options) : []);
    }

    /** Pull the latest system data from the source compendium and replace this item's with it */
    async refreshFromCompendium(): Promise<void> {
        if (!this.isOwned) return ui.notifications.error("This utility may only be used on owned items");

        if (!this.sourceId?.startsWith("Compendium.")) {
            ui.notifications.warn(`Item "${this.name}" has no compendium source.`);
            return;
        }

        const currentSource = this.toObject();
        const latestSource = (await fromUuid<this>(this.sourceId))?.toObject();
        if (!latestSource) {
            ui.notifications.warn(
                `The compendium source for "${this.name}" (source ID: ${this.sourceId}) was not found.`
            );
            return;
        } else if (latestSource.type !== this.type) {
            ui.notifications.error(
                `The compendium source for "${this.name}" is of a different type than what is present on this actor.`
            );
            return;
        }

        const updatedImage = currentSource.img.endsWith(".svg") ? latestSource.img : currentSource.img;
        const updates: DocumentUpdateData<this> = { img: updatedImage, system: latestSource.system };

        if (isPhysicalData(currentSource)) {
            // Preserve container ID
            const { containerId, quantity } = currentSource.system;
            mergeObject(updates, expandObject({ "system.containerId": containerId, "system.quantity": quantity }));
        } else if (currentSource.type === "spell") {
            // Preserve spellcasting entry location
            mergeObject(updates, expandObject({ "system.location.value": currentSource.system.location.value }));
        } else if (currentSource.type === "feat") {
            // Preserve feat location
            mergeObject(updates, expandObject({ "system.location": currentSource.system.location }));
        }

        // Preserve precious material and runes
        if (currentSource.type === "weapon" || currentSource.type === "armor") {
            const materialAndRunes: Record<string, unknown> = {
                "system.preciousMaterial": currentSource.system.preciousMaterial,
                "system.preciousMaterialGrade": currentSource.system.preciousMaterialGrade,
                "system.potencyRune": currentSource.system.potencyRune,
                "system.propertyRune1": currentSource.system.propertyRune1,
                "system.propertyRune2": currentSource.system.propertyRune2,
                "system.propertyRune3": currentSource.system.propertyRune3,
                "system.propertyRune4": currentSource.system.propertyRune4,
            };
            if (currentSource.type === "weapon") {
                materialAndRunes["system.strikingRune"] = currentSource.system.strikingRune;
            } else {
                materialAndRunes["system.resiliencyRune"] = currentSource.system.resiliencyRune;
            }
            mergeObject(updates, expandObject(materialAndRunes));
        }

        await this.update(updates, { diff: false, recursive: false });
        ui.notifications.info(`Item "${this.name}" has been refreshed.`);
    }

    /* -------------------------------------------- */
    /*  Chat Card Data                              */
    /* -------------------------------------------- */

    /**
     * Internal method that transforms data into something that can be used for chat.
     * Currently renders description text using enrichHTML.
     */
    protected async processChatData(
        htmlOptions: EnrichHTMLOptionsPF2e = {},
        data: ItemSummaryData
    ): Promise<ItemSummaryData> {
        data.properties = data.properties?.filter((property) => property !== null) ?? [];
        if (isItemSystemData(data)) {
            const chatData = duplicate(data);
            htmlOptions.rollData = mergeObject(this.getRollData(), htmlOptions.rollData ?? {});
            chatData.description.value = await game.pf2e.TextEditor.enrichHTML(chatData.description.value, {
                ...htmlOptions,
                async: true,
            });

            return chatData;
        }

        return data;
    }

    async getChatData(
        htmlOptions: EnrichHTMLOptionsPF2e = {},
        _rollOptions: Record<string, unknown> = {}
    ): Promise<ItemSummaryData> {
        if (!this.actor) throw ErrorPF2e(`Cannot retrieve chat data for unowned item ${this.name}`);
        const systemData: Record<string, unknown> = { ...this.system, traits: this.traitChatData() };
        return this.processChatData(htmlOptions, deepClone(systemData));
    }

    protected traitChatData(dictionary: Record<string, string | undefined> = {}): TraitChatData[] {
        const traits: string[] = [...(this.system.traits?.value ?? [])].sort();
        const customTraits =
            this.system.traits?.custom
                .trim()
                .split(/\s*[,;|]\s*/)
                .filter((trait) => trait) ?? [];
        traits.push(...customTraits);

        const traitChatLabels = traits.map((trait) => {
            const label = dictionary[trait] ?? trait;
            const traitDescriptions: Record<string, string | undefined> = CONFIG.PF2E.traitsDescriptions;

            return {
                value: trait,
                label,
                description: traitDescriptions[trait],
            };
        });

        return traitChatLabels;
    }

    /* -------------------------------------------- */
    /*  Roll Attacks                                */
    /* -------------------------------------------- */

    /**
     * Roll a NPC Attack
     * Rely upon the DicePF2e.d20Roll logic for the core implementation
     */
    rollNPCAttack(this: Embedded<ItemPF2e>, event: JQuery.ClickEvent, multiAttackPenalty = 1): void {
        if (this.type !== "melee") throw ErrorPF2e("Wrong item type!");
        if (!this.actor?.isOfType("hazard")) {
            throw ErrorPF2e("Attempted to roll an attack without an actor!");
        }
        // Prepare roll data
        const itemData: any = this.getChatData();
        const rollData: HazardSystemData & { item?: unknown; itemBonus?: number } = deepClone(this.actor.system);
        const parts = ["@itemBonus"];
        const title = `${this.name} - Attack Roll${multiAttackPenalty > 1 ? ` (MAP ${multiAttackPenalty})` : ""}`;

        rollData.item = itemData;
        rollData.itemBonus = Number(itemData.bonus.value) || 0;

        if (multiAttackPenalty === 2) parts.push(itemData.map2);
        else if (multiAttackPenalty === 3) parts.push(itemData.map3);

        // Call the roll helper utility
        DicePF2e.d20Roll({
            event,
            parts,
            actor: this.actor,
            data: rollData as unknown as Record<string, unknown>,
            rollType: "attack-roll",
            title,
            speaker: ChatMessage.getSpeaker({ actor: this.actor }),
            dialogOptions: {
                width: 400,
                top: event ? event.clientY - 80 : 400,
                left: window.innerWidth - 710,
            },
        });
    }

    /**
     * Roll NPC Damage
     * Rely upon the DicePF2e.damageRoll logic for the core implementation
     */
    rollNPCDamage(this: Embedded<ItemPF2e>, event: JQuery.ClickEvent, critical = false): void {
        if (!this.isOfType("melee")) throw ErrorPF2e("Wrong item type!");
        if (!this.actor.isOfType("hazard")) {
            throw ErrorPF2e("Attempted to roll an attack without an actor!");
        }

        // Get item and actor data and format it for the damage roll
        const systemData = this.system;
        const rollData: HazardSystemData & { item?: MeleeSystemData } = this.actor.toObject(false).system;
        let parts: (string | number)[] = [];
        const partsType: string[] = [];

        // If the NPC is using the updated NPC Attack data object
        if (systemData.damageRolls && typeof systemData.damageRolls === "object") {
            Object.keys(systemData.damageRolls).forEach((key) => {
                if (systemData.damageRolls[key].damage) parts.push(systemData.damageRolls[key].damage);
                partsType.push(`${systemData.damageRolls[key].damage} ${systemData.damageRolls[key].damageType}`);
            });
        }

        // Set the title of the roll
        const title = `${this.name}: ${partsType.join(", ")}`;

        // do nothing if no parts are provided in the damage roll
        if (parts.length === 0) {
            console.warn("PF2e System | No damage parts provided in damage roll");
            parts = ["0"];
        }

        // Call the roll helper utility
        rollData.item = systemData;
        DicePF2e.damageRoll({
            event,
            parts,
            critical,
            actor: this.actor,
            data: rollData as unknown as Record<string, unknown>,
            title,
            speaker: ChatMessage.getSpeaker({ actor: this.actor }),
            dialogOptions: {
                width: 400,
                top: event.clientY - 80,
                left: window.innerWidth - 710,
            },
        });
    }

    /** Don't allow the user to create a condition or spellcasting entry from the sidebar. */
    static override async createDialog(
        data: { folder?: string } = {},
        options: Partial<FormApplicationOptions> = {}
    ): Promise<ItemPF2e | undefined> {
        const original = game.system.documentTypes.Item;
        game.system.documentTypes.Item = original.filter(
            (itemType: string) =>
                !["condition", "spellcastingEntry"].includes(itemType) &&
                !(itemType === "book" && BUILD_MODE === "production")
        );
        const newItem = super.createDialog(data, options) as Promise<ItemPF2e | undefined>;
        game.system.documentTypes.Item = original;
        return newItem;
    }

    /** Assess and pre-process this JSON data, ensuring it's importable and fully migrated */
    override async importFromJSON(json: string): Promise<this> {
        const processed = await preImportJSON(this, json);
        return processed ? super.importFromJSON(processed) : this;
    }

    static override async createDocuments<T extends ConstructorOf<ItemPF2e>>(
        this: T,
        data: PreCreate<InstanceType<T>["_source"]>[] = [],
        context: DocumentModificationContext<InstanceType<T>> = {}
    ): Promise<InstanceType<T>[]> {
        if (context.parent) {
            const validTypes = context.parent.allowedItemTypes;
            if (validTypes.includes("physical")) validTypes.push(...PHYSICAL_ITEM_TYPES, "kit");

            // Check if this item is valid for this actor
            for (const datum of data) {
                if (datum.type && !validTypes.includes(datum.type)) {
                    ui.notifications.error(
                        game.i18n.format("PF2E.Item.CannotAddType", {
                            type: game.i18n.localize(CONFIG.Item.typeLabels[datum.type] ?? datum.type.titleCase()),
                        })
                    );
                    return [];
                }
            }

            const kits = data.filter((d) => d.type === "kit");
            const nonKits = data.filter((d) => !kits.includes(d));

            // Perform character pre-create deletions
            if (context.parent.isOfType("character")) {
                await context.parent.preCreateDelete(nonKits);
            }

            for (const source of [...nonKits]) {
                if (!source.system?.rules?.length) continue;
                if (!(context.keepId || context.keepEmbeddedIds)) {
                    delete source._id; // Allow a random ID to be set by rule elements, which may toggle on `keepId`
                }

                const item = new ItemPF2e(source, { parent: context.parent }) as Embedded<ItemPF2e>;
                // Pre-load this item's self: roll options for predication by preCreate rule elements
                item.prepareActorData?.();

                const rules = item.prepareRuleElements({ suppressWarnings: true });
                for (const rule of rules) {
                    const ruleSource = source.system.rules[rules.indexOf(rule)] as RuleElementSource;
                    await rule.preCreate?.({ itemSource: source, ruleSource, pendingItems: nonKits, context });
                }
            }

            for (const kitSource of kits) {
                const item = new ItemPF2e(kitSource);
                if (item.isOfType("kit")) await item.dumpContents({ actor: context.parent });
            }

            // Pre-sort unnested, class features according to their sorting from the class
            if (nonKits.length > 1 && nonKits.some((i) => i.type === "class")) {
                type PartialSourceWithLevel = PreCreate<InstanceType<T>["_source"]> & {
                    system: { level: { value: number } };
                };
                const classFeatures = nonKits.filter(
                    (i): i is PartialSourceWithLevel =>
                        i.type === "feat" &&
                        typeof i.system?.level?.value === "number" &&
                        i.system.featType?.value === "classfeature" &&
                        !i.flags?.pf2e?.grantedBy
                );
                for (const feature of classFeatures) {
                    feature.sort = classFeatures.indexOf(feature) * 100 * feature.system.level.value;
                }
            }

            return super.createDocuments(nonKits, context) as Promise<InstanceType<T>[]>;
        }

        return super.createDocuments(data, context) as Promise<InstanceType<T>[]>;
    }

    static override async deleteDocuments<T extends ConstructorOf<ItemPF2e>>(
        this: T,
        ids: string[] = [],
        context: DocumentModificationContext<InstanceType<T>> = {}
    ): Promise<InstanceType<T>[]> {
        ids = Array.from(new Set(ids));
        const actor = context.parent;
        if (actor) {
            const items = ids.flatMap((id) => actor.items.get(id) ?? []);

            // If a container is being deleted, its contents need to have their containerId references updated
            const containers = items.filter((i): i is Embedded<ContainerPF2e> => i.isOfType("backpack"));
            for (const container of containers) {
                await container.ejectContents();
            }

            // Run RE pre-delete callbacks
            for (const item of items) {
                for (const rule of item.rules) {
                    await rule.preDelete?.({ pendingItems: items, context });
                }
            }
            ids = Array.from(new Set(items.map((i) => i.id))).filter((id) => actor.items.has(id));
        }

        return super.deleteDocuments(ids, context) as Promise<InstanceType<T>[]>;
    }

    /* -------------------------------------------- */
    /*  Event Listeners and Handlers                */
    /* -------------------------------------------- */

    protected override async _preCreate(
        data: PreDocumentId<this["_source"]>,
        options: DocumentModificationContext<this>,
        user: UserPF2e
    ): Promise<void> {
        // Set default icon
        if (this._source.img === ItemPF2e.DEFAULT_ICON) {
            this._source.img = data.img = `systems/pf2e/icons/default-icons/${data.type}.svg`;
        }

        // If this item is of a certain type and is being added to a PC, change current HP along with any change to max
        if (this.actor?.isOfType("character") && this.isOfType("ancestry", "background", "class", "feat", "heritage")) {
            const clone = this.actor.clone({
                items: [...this.actor.items.toObject(), data],
            });
            const hpMaxDifference = clone.hitPoints.max - this.actor.hitPoints.max;
            if (hpMaxDifference !== 0) {
                const newHitPoints = this.actor.hitPoints.value + hpMaxDifference;
                await this.actor.update(
                    { "system.attributes.hp.value": newHitPoints },
                    { render: false, allowHPOverage: true }
                );
            }
        }

        await super._preCreate(data, options, user);

        // Ensure imported items are current on their schema version
        if (!options.parent) {
            await MigrationRunner.ensureSchemaVersion(this, MigrationList.constructFromVersion(this.schemaVersion));
        }

        // Remove any rule elements that request their own removal upon item creation
        this._source.system.rules = this._source.system.rules.filter((r) => !r.removeUponCreate);
    }

    /** Keep `TextEditor` and anything else up to no good from setting this item's description to `null` */
    protected override async _preUpdate(
        changed: DeepPartial<this["_source"]>,
        options: DocumentModificationContext<this>,
        user: UserPF2e
    ): Promise<void> {
        if (changed.system?.description?.value === null) {
            changed.system.description.value = "";
        }

        // If this item is of a certain type and belongs to a PC, change current HP along with any change to max
        if (this.actor?.isOfType("character") && this.isOfType("ancestry", "background", "class", "feat", "heritage")) {
            const actorClone = this.actor.clone();
            const item = actorClone.items.get(this.id, { strict: true });
            item.updateSource(changed, options);
            actorClone.reset();

            const hpMaxDifference = actorClone.hitPoints.max - this.actor.hitPoints.max;
            if (hpMaxDifference !== 0) {
                const newHitPoints = this.actor.hitPoints.value + hpMaxDifference;
                await this.actor.update(
                    { "system.attributes.hp.value": newHitPoints },
                    { render: false, allowHPOverage: true }
                );
            }
        }

        // Run preUpdateItem rule element callbacks
        for (const rule of this.rules) {
            await rule.preUpdate?.(changed);
        }

        await super._preUpdate(changed, options, user);
    }

    /** Call onCreate rule-element hooks */
    protected override _onCreate(
        data: ItemSourcePF2e,
        options: DocumentModificationContext<this>,
        userId: string
    ): void {
        super._onCreate(data, options, userId);

        if (this.actor && game.user.id === userId) {
            this.actor.reset();
            const actorUpdates: Record<string, unknown> = {};
            for (const rule of this.rules) {
                rule.onCreate?.(actorUpdates);
            }
            this.actor.update(actorUpdates);
        }
    }

    /** Call onDelete rule-element hooks */
    protected override _onDelete(options: DocumentModificationContext, userId: string): void {
        super._onDelete(options, userId);
        if (!(this.actor && game.user.id === userId)) return;

        if (!(this.actor.isOfType("creature") && this.canUserModify(game.user, "update"))) return;
        const actorUpdates: DocumentUpdateData<ActorPF2e> = {};
        for (const rule of this.rules) rule.onDelete?.(actorUpdates);

        // Remove attack effect from melee items if this deleted item was the source
        if (this.actor.isOfType("npc") && ["action", "consumable"].includes(this.type)) {
            const slug = this.slug ?? sluggify(this.name);
            if (!this.actor.isToken) {
                const itemUpdates: DocumentUpdateData<ItemPF2e>[] = [];
                for (const attack of this.actor.itemTypes.melee) {
                    const attackEffects = attack.system.attackEffects.value;
                    if (attackEffects.includes(slug)) {
                        const updatedEffects = attackEffects.filter((effect) => effect !== slug);
                        itemUpdates.push({
                            _id: attack.id,
                            system: { attackEffects: { value: updatedEffects } },
                        });
                    }
                }
                if (itemUpdates.length > 0) {
                    mergeObject(actorUpdates, { items: itemUpdates });
                }
            } else {
                // The above method of updating embedded items in an actor update does not work with synthetic actors
                const promises: Promise<ItemPF2e>[] = [];
                for (const item of this.actor.itemTypes.melee) {
                    const attackEffects = item.system.attackEffects.value;
                    if (attackEffects.includes(slug)) {
                        const updatedEffects = attackEffects.filter((effect) => effect !== slug);
                        promises.push(item.update({ ["system.attackEffects.value"]: updatedEffects }));
                    }
                }
                if (promises.length > 0) {
                    Promise.allSettled(promises);
                }
            }
        }

        this.actor.update(actorUpdates);
    }
}

interface ItemPF2e {
    readonly data: ItemDataPF2e;

    readonly parent: ActorPF2e | null;

    _sheet: ItemSheetPF2e<this> | null;

    get sheet(): ItemSheetPF2e<this>;

    prepareSiblingData?(this: Embedded<ItemPF2e>): void;

    prepareActorData?(this: Embedded<ItemPF2e>): void;
}

export { ItemPF2e, ItemConstructionContextPF2e };
