const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');

module.exports = {
    ticket: {
        name: 'ticket',
        description: 'Create a support ticket',
        options: [
            { name: 'reason', description: 'Reason for ticket', type: 3, required: true }
        ],
        async execute(interaction) {
            const category = process.env.TICKET_CATEGORY_ID;
            const reason = interaction.options.getString('reason');

            const ticket = await interaction.guild.channels.create({
                name: `ticket-${interaction.user.username}`,
                type: 0, // text
                parent: category,
                permissionOverwrites: [
                    { id: interaction.user.id, allow: ['ViewChannel', 'SendMessages'] },
                    { id: interaction.guild.roles.everyone.id, deny: ['ViewChannel'] }
                ]
            });

            // Dropdown to claim ticket
            const row = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`ticket-claim-${ticket.id}`)
                    .setPlaceholder('Claim this ticket')
                    .addOptions([
                        { label: 'Claim Ticket', value: 'claim' }
                    ])
            );

            const embed = new EmbedBuilder()
                .setTitle('Ticket Created')
                .setDescription(`Ticket created by ${interaction.user.tag}\nReason: ${reason}`)
                .setColor('Blue');

            ticket.send({ embeds: [embed], components: [row] });
            await interaction.reply({ content: `Ticket created: ${ticket}`, ephemeral: true });
        }
    },

    ticketDropdown: async (interaction, client) => {
        if (interaction.values[0] === 'claim') {
            const embed = new EmbedBuilder()
                .setTitle('Ticket Claimed')
                .setDescription(`${interaction.user.tag} has claimed this ticket.`)
                .setColor('Green');
            await interaction.update({ embeds: [embed], components: [] });
        }
    },
