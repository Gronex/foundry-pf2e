/**
 * Extend the base Actor class to implement additional logic specialized for PF2e.
 */
class ActorPF2e extends Actor {

  /**
   * Augment the basic actor data with additional dynamic data.
   */
  prepareData(actorData) {
    actorData = super.prepareData(actorData);
    const data = actorData.data;

    // Ability modifiers
    for (let abl of Object.values(data.abilities)) {
      abl.mod = Math.floor((abl.value - 10) / 2);
    }

    // Prepare Character data
    if ( actorData.type === "character" ) this._prepareCharacterData(data);
    else if ( actorData.type === "npc" ) this._prepareNPCData(data);

    // TODO: Migrate trait storage format
    const map = {
      "dr": CONFIG.damageTypes,
      "di": CONFIG.damageTypes,
      "dv": CONFIG.damageTypes,
      "ci": CONFIG.conditionTypes,
      "languages": CONFIG.languages
    };
    for ( let [t, choices] of Object.entries(map) ) {
      let trait = data.traits[t];
      if (!( trait.value instanceof Array )) {
        trait.value = TraitSelector5e._backCompat(trait.value, choices);
      }
    }

    // Return the prepared Actor data
    return actorData;
  }

  /* -------------------------------------------- */

  /**
   * Prepare Character type specific data
   */
  _prepareCharacterData(data) {

    // Level, experience, and proficiency
    data.details.level.value = parseInt(data.details.level.value);
    data.details.xp.max = 1000;
    data.details.xp.pct = Math.min(Math.round((data.details.xp.value) * 100 / 1000), 99.5);

    // Saves
    for (let save of Object.values(data.saves)) {
      let proficiency = save.rank ? (save.rank * 2) + data.details.level.value : 0;
      save.value = data.abilities[save.ability].mod + proficiency + save.item;
      save.breakdown = `${save.ability} modifier(${data.abilities[save.ability].mod}) + proficiency(${proficiency}) + item bonus(${save.item})`;
    }

    // Martial
    for (let skl of Object.values(data.martial)) {
      let proficiency = skl.rank ? (skl.rank * 2) + data.details.level.value : 0;
      skl.value = proficiency;
      skl.breakdown = `proficiency(${proficiency})`;
    }

    // Perception
    let proficiency = data.attributes.perception.rank ? (data.attributes.perception.rank * 2) + data.details.level.value : 0;
    data.attributes.perception.value = data.abilities[data.attributes.perception.ability].mod + proficiency + data.attributes.perception.item;
    data.attributes.perception.breakdown = `${data.attributes.perception.ability} modifier(${data.abilities[data.attributes.perception.ability].mod}) + proficiency(${proficiency}) + item bonus(${data.attributes.perception.item})`;

    // Spell DC
    let spellProficiency = data.attributes.spelldc.rank ? (data.attributes.spelldc.rank * 2) + data.details.level.value : 0;
    let spellAbl = data.attributes.spellcasting.value || "int";
    data.attributes.spelldc.value = data.abilities[spellAbl].mod + spellProficiency + data.attributes.spelldc.item;
    data.attributes.spelldc.dc = data.attributes.spelldc.value + 10
    data.attributes.spelldc.breakdown = `10 + ${spellAbl} modifier(${data.abilities[spellAbl].mod}) + proficiency(${spellProficiency}) + item bonus(${data.attributes.spelldc.item})`;


    // Skill modifiers
    for (let skl of Object.values(data.skills)) {
      //skl.value = parseFloat(skl.value || 0);
      let proficiency = skl.rank ? (skl.rank * 2) + data.details.level.value : 0;      
      skl.mod = data.abilities[skl.ability].mod;

      if (skl.armor) {
        let armorCheckPenalty = skl.armor ? (data.attributes.ac.check || 0) : 0;
        skl.value = data.abilities[skl.ability].mod + proficiency + skl.item + armorCheckPenalty;
        skl.breakdown = `${skl.ability} modifier(${data.abilities[skl.ability].mod}) + proficiency(${proficiency}) + item bonus(${skl.item}) + armor check penalty(${armorCheckPenalty})`;
      } else {
        skl.value = data.abilities[skl.ability].mod + proficiency + skl.item;
        skl.breakdown = `${skl.ability} modifier(${data.abilities[skl.ability].mod}) + proficiency(${proficiency}) + item bonus(${skl.item})`;
      }
      
    }
  }

  /* -------------------------------------------- */

  /**
   * Prepare NPC type specific data
   */
  _prepareNPCData(data) {

  }

  /* -------------------------------------------- */
  /*  Rolls                                       */
  /* -------------------------------------------- */

  /**
   * Roll a Skill Check
   * Prompt the user for input regarding Advantage/Disadvantage and any Situational Bonus
   * @param skill {String}    The skill id
   */
  rollSkill(event, skillName) {
    let skl = this.data.data.skills[skillName],
      parts = ["@mod"],
      flavor = `${skl.label} Skill Check`;

    // Call the roll helper utility
    DicePF2e.d20Roll({
      event: event,
      parts: parts,
      data: {mod: skl.value},
      title: flavor,
      speaker: ChatMessage.getSpeaker({actor: this}),
    });
  }

  /* -------------------------------------------- */

  /**
   * Roll a Lore (Item) Skill Check
   * Prompt the user for input regarding Advantage/Disadvantage and any Situational Bonus
   * @param skill {String}    The skill id
   */
  rollLoreSkill(event, item) {
    let parts = ["@mod"],
      flavor = `${item.name} Skill Check`;

    // Call the roll helper utility
    DicePF2e.d20Roll({
      event: event,
      parts: parts,
      data: {mod: item.data.data.value},
      title: flavor,
      speaker: ChatMessage.getSpeaker({actor: this}),
    });
  }

  /* -------------------------------------------- */
  /**
   * Roll a Save Check
   * Prompt the user for input regarding Advantage/Disadvantage and any Situational Bonus
   * @param skill {String}    The skill id
   */
  rollSave(event, saveName) {
    let save = this.data.data.saves[saveName],
      parts = ["@mod"],
      flavor = `${save.label} Save Check`;

    // Call the roll helper utility
    DicePF2e.d20Roll({
      event: event,
      parts: parts,
      data: {mod: save.value},
      title: flavor,
      speaker: ChatMessage.getSpeaker({actor: this}),
    });
  }

  /* -------------------------------------------- */

  /**
   * Roll a Attribute Check
   * Prompt the user for input regarding Advantage/Disadvantage and any Situational Bonus
   * @param skill {String}    The skill id
   */
  rollAttribute(event, attributeName) {
    let skl = this.data.data.attributes[attributeName],
      parts = ["@mod"],
      flavor = `${skl.label} skl Check`;

    // Call the roll helper utility
    DicePF2e.d20Roll({
      event: event,
      parts: parts,
      data: {mod: skl.value},
      title: flavor,
      speaker: ChatMessage.getSpeaker({actor: this}),
    });
  }

  /* -------------------------------------------- */

  /**
   * Apply rolled dice damage to the token or tokens which are currently controlled.
   * This allows for damage to be scaled by a multiplier to account for healing, critical hits, or resistance
   *
   * @param {HTMLElement} roll    The chat entry which contains the roll data
   * @param {Number} multiplier   A damage multiplier to apply to the rolled damage.
   * @return {Promise}
   */
  static async applyDamage(roll, multiplier) {
    let value = Math.floor(parseFloat(roll.find('.dice-total').text()) * multiplier);
    const promises = [];
    for ( let t of canvas.tokens.controlled ) {
      let a = t.actor,
          hp = a.data.data.attributes.hp,
          tmp = parseInt(hp.temp),
          dt = value > 0 ? Math.min(tmp, value) : 0;
      promises.push(t.actor.update({
        "data.attributes.hp.temp": tmp - dt,
        "data.attributes.hp.value": Math.clamped(hp.value - (value - dt), 0, hp.max)
      }));
    }
    return Promise.all(promises);
  }
}

// Assign the actor class to the CONFIG
CONFIG.Actor.entityClass = ActorPF2e;


/**
 * Hijack Token health bar rendering to include temporary and temp-max health in the bar display
 * TODO: This should probably be replaced with a formal Token class extension
 * @private
 */
/* const _drawBar = Token.prototype._drawBar;
Token.prototype._drawBar = function(number, bar, data) {
  if ( data.attribute === "attributes.hp" ) {
    data = duplicate(data);
    data.value += parseInt(data['temp'] || 0);
    data.max += parseInt(data['tempmax'] || 0);
  }
  _drawBar.bind(this)(number, bar, data);
}; */

