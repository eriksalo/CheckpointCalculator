// VDURA Tiering Calculator
// GPU Checkpoint Workflow Simulation

let animationInterval = null;
let pricingData = null;

let workflowParams = {
    checkpointSize: 100,
    checkpointInterval: 60,
    numCheckpoints: 5,
    vduraMigrationTime: 0,
    competitorMigrationTime: 0
};

let systemConfigs = {
    vdura: {},
    competitor: {}
};

let animationState = {
    vdura: {
        checkpoints: [],
        nextCheckpointId: 1,
        timeSinceLastCheckpoint: 0
    },
    competitor: {
        checkpoints: [],
        nextCheckpointId: 1,
        timeSinceLastCheckpoint: 0
    }
};

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
    await loadPricingData();
    initializeEventListeners();
    calculate();
    startAnimation();
});

// Load pricing data from JSON
async function loadPricingData() {
    try {
        const response = await fetch('pricing-config.json');
        pricingData = await response.json();
        console.log('Pricing data loaded successfully');
    } catch (error) {
        console.error('Error loading pricing data:', error);
        // Continue without pricing data
    }
}

// Event listeners for all inputs
function initializeEventListeners() {
    document.getElementById('performance').addEventListener('input', calculate);
    document.getElementById('total-capacity').addEventListener('input', calculate);
    document.getElementById('ssd-percentage').addEventListener('input', (e) => {
        const ssdPercentage = parseInt(e.target.value);
        document.getElementById('ssd-percentage-display').textContent = ssdPercentage;
        calculate();
    });
    document.getElementById('competitor-type').addEventListener('change', calculate);
    document.getElementById('checkpoint-size').addEventListener('input', calculate);
    document.getElementById('checkpoint-interval').addEventListener('input', calculate);
    document.getElementById('num-checkpoints').addEventListener('input', calculate);
}

// Main calculation function
function calculate() {
    // Get user requirements
    const totalCapacityPB = parseFloat(document.getElementById('total-capacity').value);
    const ssdPercentage = parseFloat(document.getElementById('ssd-percentage').value);
    const performanceGBs = parseFloat(document.getElementById('performance').value);
    const competitorType = document.getElementById('competitor-type').value;
    const checkpointSize = parseFloat(document.getElementById('checkpoint-size').value);
    const checkpointInterval = parseFloat(document.getElementById('checkpoint-interval').value);
    const numCheckpoints = parseInt(document.getElementById('num-checkpoints').value);

    const totalCapacityTB = totalCapacityPB * 1000;

    // Determine competitor color scheme
    const isCompetitorW = competitorType.startsWith('weka');
    const competitorColor = isCompetitorW ? 'purple' : 'blue';
    updateCompetitorColors(competitorColor);

    // Architecture constants
    const VPOD_PERFORMANCE = 65; // GB/s per VPOD
    const VPOD_SSD_COUNT = 12; // SSDs per VPOD
    const VELO_SSD_COUNT = 2; // SSDs per VELO
    const VELO_SSD_SIZE = 2; // TB
    const COMPETITOR_NODE_PERFORMANCE = 40; // GB/s per node (Nitro)
    const COMPETITOR_SSD_COUNT = 14; // SSDs per node
    const JBOD_BANDWIDTH = 21.5; // GB/s per JBOD
    const JBOD_CAPACITY_TB = 3240; // 108x 30TB HDDs
    const S3_BANDWIDTH = 5; // GB/s (fixed bottleneck)
    const MIN_VPODS = 3;
    const MIN_COMPETITOR_NODES = 8;

    // Calculate VDURA configuration
    const vduraSSDCapacityTB = totalCapacityTB * (ssdPercentage / 100);
    const vduraHDDCapacityTB = totalCapacityTB - vduraSSDCapacityTB;

    // VPODs needed for performance
    const vpodsForPerformance = Math.ceil(performanceGBs / VPOD_PERFORMANCE);

    // VPODs needed for SSD capacity (using largest SSD = 30TB)
    const largestSSD = 30;
    const maxSSDCapacityPerVPOD = largestSSD * VPOD_SSD_COUNT;
    const vpodsForCapacity = Math.ceil(vduraSSDCapacityTB / maxSSDCapacityPerVPOD);

    // Calculate JBODs needed
    let numJBODs = Math.ceil(vduraHDDCapacityTB / JBOD_CAPACITY_TB);
    if (numJBODs > 0 && numJBODs < 3) {
        numJBODs = 3; // Minimum 3 JBODs if any are needed
    }

    // Determine minimum VPODs based on JBOD configuration
    let minVPODs = MIN_VPODS;
    const initialVPODs = Math.max(vpodsForPerformance, vpodsForCapacity, minVPODs);
    if (numJBODs > 0 && numJBODs < initialVPODs) {
        minVPODs = 6; // If JBODs exist and JBODs < VPODs, need 6 minimum
    }

    // Final VPOD count
    const totalVPODs = Math.max(vpodsForPerformance, vpodsForCapacity, minVPODs);

    // Calculate VELOs: 3 base + 1 for every 10 VPODs
    const totalVELOs = 3 + Math.floor((totalVPODs - 1) / 10);

    // Optimize SSD size for VPODs
    const ssdSizes = [8, 15, 30];
    let vduraSSDSize = null;
    for (let size of ssdSizes) {
        const totalSSDCapacity = totalVPODs * VPOD_SSD_COUNT * size;
        if (totalSSDCapacity >= vduraSSDCapacityTB) {
            vduraSSDSize = size;
            break;
        }
    }
    if (!vduraSSDSize) {
        vduraSSDSize = 30; // Use largest if none fit
    }

    // Calculate actual capacities
    const veloSSDCapacity = totalVELOs * VELO_SSD_COUNT * VELO_SSD_SIZE;
    const vpodSSDCapacity = totalVPODs * VPOD_SSD_COUNT * vduraSSDSize;
    const actualVduraSSDCapacity = veloSSDCapacity + vpodSSDCapacity;
    const actualVduraHDDCapacity = numJBODs * JBOD_CAPACITY_TB;

    const vdura = {
        velos: totalVELOs,
        vpods: totalVPODs,
        ssdSize: vduraSSDSize,
        ssdBandwidth: totalVPODs * VPOD_PERFORMANCE,
        ssdCapacity: actualVduraSSDCapacity,
        jbods: numJBODs,
        hddBandwidth: numJBODs * JBOD_BANDWIDTH,
        hddCapacity: actualVduraHDDCapacity,
        migrationBandwidth: numJBODs * JBOD_BANDWIDTH
    };

    // Calculate Competitor configuration based on type
    const competitorSSDCapacityTB = totalCapacityTB; // Competitor is all-flash
    let competitor;

    if (pricingData) {
        const q2Pricing = pricingData.quarters['Q2_2026'];
        const competitorPricing = q2Pricing[competitorType];

        if (competitorType === 'weka_nitro' || competitorType === 'weka_prime') {
            competitor = calculateCompetitorWEKA(performanceGBs, competitorSSDCapacityTB, competitorPricing, competitorType);
        } else if (competitorType === 'comp_v_ebox') {
            competitor = calculateCompetitorVEBox(performanceGBs, competitorSSDCapacityTB, competitorPricing);
        } else if (competitorType === 'comp_v_cbox_dbox') {
            competitor = calculateCompetitorVCDBox(performanceGBs, competitorSSDCapacityTB, competitorPricing);
        }

        // Add S3 tier info
        competitor.s3Bandwidth = S3_BANDWIDTH;
        competitor.s3Capacity = actualVduraHDDCapacity;
        competitor.migrationBandwidth = S3_BANDWIDTH;
    } else {
        // Fallback if pricing data not loaded
        const competitorNodesForPerformance = Math.ceil(performanceGBs / COMPETITOR_NODE_PERFORMANCE);
        const totalCompetitorNodes = Math.max(competitorNodesForPerformance, MIN_COMPETITOR_NODES);
        const competitorSSDSize = 30;
        const actualCompetitorSSDCapacity = totalCompetitorNodes * COMPETITOR_SSD_COUNT * competitorSSDSize;

        competitor = {
            nodes: totalCompetitorNodes,
            ssdSize: competitorSSDSize,
            ssdBandwidth: totalCompetitorNodes * COMPETITOR_NODE_PERFORMANCE,
            ssdCapacity: actualCompetitorSSDCapacity,
            s3Bandwidth: S3_BANDWIDTH,
            s3Capacity: actualVduraHDDCapacity,
            migrationBandwidth: S3_BANDWIDTH
        };
    }

    // Calculate VDURA costs if pricing data is available
    if (pricingData && vdura) {
        const q2Pricing = pricingData.quarters['Q2_2026'];
        const vduraCost = calculateVDURACost(vdura, q2Pricing.vdura);
        vdura.totalCost = vduraCost;
    }

    // Competitor already has totalCost from calculation functions

    // Store configs globally for animation system
    systemConfigs.vdura = vdura;
    systemConfigs.competitor = competitor;

    // Checkpoint workflow calculations
    const totalCheckpointCapacity = checkpointSize * numCheckpoints;

    // VDURA migration time (checkpoint size / migration bandwidth)
    const vduraMigrationTime = (checkpointSize * 1000) / vdura.migrationBandwidth / 60; // minutes
    const vduraCanKeepUp = vduraMigrationTime < checkpointInterval;
    const vduraUtilization = Math.min(100, (totalCheckpointCapacity / vdura.ssdCapacity) * 100);

    // Competitor migration time
    const competitorMigrationTime = (checkpointSize * 1000) / competitor.migrationBandwidth / 60; // minutes
    const competitorCanKeepUp = competitorMigrationTime < checkpointInterval;
    const competitorUtilization = Math.min(100, (totalCheckpointCapacity / competitor.ssdCapacity) * 100);

    // Update VDURA system details
    const vduraCostDisplay = vdura.totalCost ? ` • <span class="cost-display">$${(vdura.totalCost / 1000000).toFixed(2)}M (Q2'26 Est)</span>` : '';
    document.getElementById('vdura-system-details').innerHTML = `
        <p><strong>${vdura.velos} VELOs</strong> + <strong>${vdura.vpods} VPODs</strong> × ${vdura.ssdSize}TB SSDs${vduraCostDisplay}</p>
        <p><strong>${vdura.jbods} JBODs</strong> × 3.2 PB (108× 30TB HDDs each)</p>
    `;

    // Update VDURA specs (display in PB with architecture details)
    document.getElementById('vdura-ssd-specs').innerHTML = `
        <span class="spec-bandwidth">${vdura.ssdBandwidth.toLocaleString()} GB/s</span>
        <span class="spec-capacity">${(vdura.ssdCapacity / 1000).toFixed(1)} PB</span>
    `;
    document.getElementById('vdura-hdd-specs').innerHTML = `
        <span class="spec-bandwidth">${vdura.hddBandwidth.toFixed(1)} GB/s</span>
        <span class="spec-capacity">${(vdura.hddCapacity / 1000).toFixed(1)} PB</span>
    `;

    // Update Competitor system details based on type
    const competitorCostDisplay = competitor.totalCost ? ` • <span class="cost-display">$${(competitor.totalCost / 1000000).toFixed(2)}M (Q2'26 Est)</span>` : '';
    let competitorDetailsHTML = '';

    if (competitorType === 'weka_nitro') {
        competitorDetailsHTML = `
            <p><strong>${competitor.nodes} Servers</strong> × ${competitor.ssdSize}TB SSDs (14 per server)${competitorCostDisplay}</p>
            <p><strong>S3 Object Store</strong> @ ${competitor.s3Bandwidth} GB/s (fixed bottleneck)</p>
        `;
    } else if (competitorType === 'weka_prime') {
        competitorDetailsHTML = `
            <p><strong>${competitor.nodes} Servers</strong> × 2× 8TB + 18× ${competitor.ssdSize}TB${competitorCostDisplay}</p>
            <p><strong>S3 Object Store</strong> @ ${competitor.s3Bandwidth} GB/s (fixed bottleneck)</p>
        `;
    } else if (competitorType === 'comp_v_ebox') {
        competitorDetailsHTML = `
            <p><strong>${competitor.nodes} E-Boxes</strong> × 4.8TB SLC + 9× ${competitor.ssdSize}TB QLC${competitorCostDisplay}</p>
            <p><strong>S3 Object Store</strong> @ ${competitor.s3Bandwidth} GB/s (fixed bottleneck)</p>
        `;
    } else if (competitorType === 'comp_v_cbox_dbox') {
        competitorDetailsHTML = `
            <p><strong>${competitor.cBoxes} C-Boxes</strong> + <strong>${competitor.dBoxes} D-Boxes</strong> × 5.4TB SCM + 24× ${competitor.ssdSize}TB QLC${competitorCostDisplay}</p>
            <p><strong>S3 Object Store</strong> @ ${competitor.s3Bandwidth} GB/s (fixed bottleneck)</p>
        `;
    }

    document.getElementById('competitor-system-details').innerHTML = competitorDetailsHTML;

    // Update Competitor specs (display in PB with architecture details)
    document.getElementById('competitor-ssd-specs').innerHTML = `
        <span class="spec-bandwidth">${competitor.ssdBandwidth.toLocaleString()} GB/s</span>
        <span class="spec-capacity">${(competitor.ssdCapacity / 1000).toFixed(1)} PB</span>
    `;
    document.getElementById('competitor-s3-specs').innerHTML = `
        <span class="spec-bandwidth">${competitor.s3Bandwidth} GB/s</span>
        <span class="spec-capacity">${(competitor.s3Capacity / 1000).toFixed(1)} PB</span>
    `;

    // Storage boxes now auto-size based on grid content
    // No manual dimension updates needed

    // Update migration arrows
    updateMigrationArrows(numJBODs, vdura.migrationBandwidth, competitor.migrationBandwidth);

    // Update analysis results - VDURA
    document.getElementById('vdura-migration-time').textContent = `${vduraMigrationTime.toFixed(1)} min`;
    const vduraKeepUpEl = document.getElementById('vdura-can-keep-up');
    vduraKeepUpEl.textContent = vduraCanKeepUp ? '✓ YES' : '✗ NO';
    vduraKeepUpEl.className = vduraCanKeepUp ? 'metric-value success' : 'metric-value failure';

    // Update analysis results - Competitor
    document.getElementById('competitor-migration-time').textContent = `${competitorMigrationTime.toFixed(1)} min`;
    const compKeepUpEl = document.getElementById('competitor-can-keep-up');
    compKeepUpEl.textContent = competitorCanKeepUp ? '✓ YES' : '✗ NO';
    compKeepUpEl.className = competitorCanKeepUp ? 'metric-value success' : 'metric-value failure';

    // Update insight text
    const bandwidthRatio = (vdura.migrationBandwidth / competitor.migrationBandwidth).toFixed(0);
    document.getElementById('insight-text').textContent =
        `VDURA's parallel JBOD architecture provides ${bandwidthRatio}x faster migration (${vdura.migrationBandwidth.toFixed(1)} GB/s vs ${competitor.migrationBandwidth} GB/s), ` +
        `enabling efficient checkpoint cycling while competitors become bottlenecked and fill their SSD tier.`;

    // Debug logging
    console.log('VDURA:', {
        velos: vdura.velos,
        vpods: vdura.vpods,
        ssdSize: vdura.ssdSize + 'TB',
        ssdCapacity: (vdura.ssdCapacity / 1000).toFixed(2) + ' PB',
        jbods: vdura.jbods,
        hddCapacity: (vdura.hddCapacity / 1000).toFixed(2) + ' PB',
        migrationBandwidth: vdura.migrationBandwidth.toFixed(1) + ' GB/s',
        migrationTime: vduraMigrationTime.toFixed(1) + ' min',
        canKeepUp: vduraCanKeepUp
    });
    console.log('Competitor:', {
        nodes: competitor.nodes,
        ssdSize: competitor.ssdSize + 'TB',
        ssdCapacity: (competitor.ssdCapacity / 1000).toFixed(2) + ' PB',
        s3Capacity: (competitor.s3Capacity / 1000).toFixed(2) + ' PB',
        migrationBandwidth: competitor.migrationBandwidth + ' GB/s',
        migrationTime: competitorMigrationTime.toFixed(1) + ' min',
        canKeepUp: competitorCanKeepUp
    });
    console.log('Checkpoint interval:', checkpointInterval, 'min');

    // Store workflow parameters for animation
    const paramsChanged =
        workflowParams.checkpointSize !== checkpointSize ||
        workflowParams.checkpointInterval !== checkpointInterval ||
        workflowParams.numCheckpoints !== numCheckpoints;

    workflowParams = {
        checkpointSize: checkpointSize,
        checkpointInterval: checkpointInterval,
        numCheckpoints: numCheckpoints,
        vduraMigrationTime: vduraMigrationTime,
        competitorMigrationTime: competitorMigrationTime,
        vduraCanKeepUp: vduraCanKeepUp,
        competitorCanKeepUp: competitorCanKeepUp
    };

    // Restart animation if parameters changed (especially checkpoint interval which affects speed)
    if (paramsChanged && animationInterval) {
        startAnimation(); // Restart with new time acceleration
    }
}

// Storage boxes now auto-size based on grid content - no manual sizing needed

// Update competitor colors based on type
function updateCompetitorColors(color) {
    const competitorColumn = document.querySelector('.architecture-column:last-child');
    const competitorTitle = document.querySelector('.competitor-title');
    const competitorLabels = document.querySelectorAll('.bottleneck .arrow-label-vertical');

    if (color === 'purple') {
        competitorColumn?.classList.remove('competitor-blue');
        competitorColumn?.classList.add('competitor-purple');
        competitorTitle?.classList.remove('competitor-blue-title');
        competitorTitle?.classList.add('competitor-purple-title');
    } else {
        competitorColumn?.classList.remove('competitor-purple');
        competitorColumn?.classList.add('competitor-blue');
        competitorTitle?.classList.remove('competitor-purple-title');
        competitorTitle?.classList.add('competitor-blue-title');
    }
}

// Calculate WEKA competitor (Nitro or Prime)
function calculateCompetitorWEKA(performanceRequired, capacityTB, pricing, competitorType) {
    const performancePerServer = pricing.performance_per_server_gbs;
    const serversForPerformance = Math.ceil(performanceRequired / performancePerServer);

    let servers = Math.max(serversForPerformance, pricing.min_servers);
    const ssdsPerServer = pricing.ssds_per_server;
    let ssdSize, ssdCost;

    if (competitorType === 'weka_prime') {
        // Prime: 2× 8TB boot + 18× data SSDs
        const bootCapacityPerServer = 8 * pricing.boot_ssds.count;
        const dataCapacityPerServerNeeded = (capacityTB / servers) - bootCapacityPerServer;
        const dataSSDSizeNeeded = dataCapacityPerServerNeeded / pricing.data_ssds.count;

        const dataSSDSizes = Object.keys(pricing.data_ssds)
            .filter(key => key !== 'count')
            .map(size => parseFloat(size))
            .sort((a, b) => a - b);

        let chosenDataSSD = null;
        for (let size of dataSSDSizes) {
            if (size >= dataSSDSizeNeeded) {
                chosenDataSSD = size;
                break;
            }
        }

        if (!chosenDataSSD) {
            chosenDataSSD = dataSSDSizes[dataSSDSizes.length - 1];
            const capacityPerServer = bootCapacityPerServer + (chosenDataSSD * pricing.data_ssds.count);
            const serversForCapacity = Math.ceil(capacityTB / capacityPerServer);
            servers = Math.max(serversForCapacity, serversForPerformance, pricing.min_servers);
        }

        ssdSize = chosenDataSSD;
        const capacityPerServer = bootCapacityPerServer + (chosenDataSSD * pricing.data_ssds.count);
        const ssdCapacity = servers * capacityPerServer;
        ssdCost = servers * (pricing.boot_ssds.count * pricing.boot_ssds['8TB'] +
                            pricing.data_ssds.count * pricing.data_ssds[chosenDataSSD + 'TB']);

        // Calculate costs
        const serverBaseCost = servers * pricing.server_base_cost;
        const cpuCost = servers * pricing.cpu_cost;
        const dramCost = servers * pricing.dram_gb * pricing.dram_price_per_gb;
        const nicCost = servers * pricing.nic_cost;
        const hardwareCost = serverBaseCost + cpuCost + dramCost + nicCost + ssdCost;
        const softwareCost = hardwareCost * pricing.software_support_multiplier;
        const subtotal = hardwareCost + softwareCost;
        const totalCost = subtotal * 1.15;

        return {
            nodes: servers,
            ssdSize: chosenDataSSD,
            ssdBandwidth: servers * performancePerServer,
            ssdCapacity: ssdCapacity,
            totalCost: totalCost
        };
    } else {
        // Nitro: standard 8TB/15TB/30TB SSDs
        const capacityPerServerNeeded = capacityTB / servers;
        const ssdSizeNeeded = capacityPerServerNeeded / ssdsPerServer;

        const ssdSizes = Object.keys(pricing.ssds)
            .map(size => parseFloat(size))
            .sort((a, b) => a - b);

        let chosenSSDSize = null;
        for (let size of ssdSizes) {
            if (size >= ssdSizeNeeded) {
                chosenSSDSize = size;
                break;
            }
        }

        if (!chosenSSDSize) {
            chosenSSDSize = ssdSizes[ssdSizes.length - 1];
            const capacityPerServer = chosenSSDSize * ssdsPerServer;
            const serversForCapacity = Math.ceil(capacityTB / capacityPerServer);
            servers = Math.max(serversForCapacity, serversForPerformance, pricing.min_servers);
        }

        ssdSize = chosenSSDSize;
        const ssdCapacity = servers * ssdsPerServer * chosenSSDSize;
        ssdCost = servers * ssdsPerServer * pricing.ssds[chosenSSDSize + 'TB'];

        // Calculate costs
        const serverBaseCost = servers * pricing.server_base_cost;
        const cpuCost = servers * pricing.cpu_cost;
        const dramCost = servers * pricing.dram_gb * pricing.dram_price_per_gb;
        const nicCost = servers * pricing.nic_cost;
        const hardwareCost = serverBaseCost + cpuCost + dramCost + nicCost + ssdCost;
        const softwareCost = hardwareCost * pricing.software_support_multiplier;
        const subtotal = hardwareCost + softwareCost;
        const totalCost = subtotal * 1.15;

        return {
            nodes: servers,
            ssdSize: chosenSSDSize,
            ssdBandwidth: servers * performancePerServer,
            ssdCapacity: ssdCapacity,
            totalCost: totalCost
        };
    }
}

// Calculate Competitor V E-Box (SLC + QLC)
function calculateCompetitorVEBox(performanceRequired, capacityTB, pricing) {
    const performancePerNode = pricing.performance_per_node_gbs;
    const nodesForPerformance = Math.ceil(performanceRequired / performancePerNode);

    let nodes = Math.max(nodesForPerformance, pricing.min_nodes);

    const slcSizeTB = pricing.slc_flash.size_tb;
    const qlcCount = pricing.qlc_ssds.count;

    const slcCapacityTotal = nodes * slcSizeTB;
    const qlcCapacityNeeded = capacityTB - slcCapacityTotal;
    const qlcSizePerNode = qlcCapacityNeeded / (nodes * qlcCount);

    const qlcSizes = Object.keys(pricing.qlc_ssds)
        .filter(key => key !== 'count')
        .map(size => parseFloat(size))
        .sort((a, b) => a - b);

    let chosenQLC = null;
    for (let size of qlcSizes) {
        if (size >= qlcSizePerNode) {
            chosenQLC = size;
            break;
        }
    }

    if (!chosenQLC) {
        chosenQLC = qlcSizes[qlcSizes.length - 1];
        const capacityPerNode = slcSizeTB + (chosenQLC * qlcCount);
        const nodesForCapacity = Math.ceil(capacityTB / capacityPerNode);
        nodes = Math.max(nodesForCapacity, nodesForPerformance, pricing.min_nodes);
    }

    const ssdCapacity = nodes * (slcSizeTB + (chosenQLC * qlcCount));

    // Calculate costs
    const nodeBaseCost = nodes * pricing.node_base_cost;
    const dramCost = nodes * pricing.dram_gb * pricing.dram_price_per_gb;
    const slcCost = nodes * pricing.slc_flash.cost;
    const qlcCost = nodes * qlcCount * pricing.qlc_ssds[chosenQLC + 'TB'];
    const hardwareCost = nodeBaseCost + dramCost + slcCost + qlcCost;
    const softwareCost = hardwareCost * pricing.software_support_multiplier;
    const subtotal = hardwareCost + softwareCost;
    const totalCost = subtotal * 1.15;

    return {
        nodes: nodes,
        ssdSize: chosenQLC,
        ssdBandwidth: nodes * performancePerNode,
        ssdCapacity: ssdCapacity,
        totalCost: totalCost
    };
}

// Calculate Competitor V C+D Box (separated performance and capacity)
function calculateCompetitorVCDBox(performanceRequired, capacityTB, pricing) {
    const totalCapacityTB = capacityTB;

    // Calculate C boxes needed for performance (40 GB/s per C box)
    const performancePerCBox = pricing.c_box.performance_per_node_gbs;
    const cBoxesForPerformance = Math.ceil(performanceRequired / performancePerCBox);

    // Calculate D boxes needed for capacity
    // Each D box has: 8× 800GB SCM + 22× QLC SSDs
    const scmCapacityPerDBox = (pricing.d_box.scm_drives.size_gb * pricing.d_box.scm_drives.count) / 1000; // Convert GB to TB
    const qlcCount = pricing.d_box.qlc_ssds.count;

    // Get available QLC sizes
    const qlcSizes = Object.keys(pricing.d_box.qlc_ssds)
        .filter(key => key !== 'count')
        .map(size => parseFloat(size))
        .sort((a, b) => a - b);

    // Start with minimum D boxes and find the smallest QLC that works
    let dBoxesForCapacity = pricing.min_d_boxes;
    let chosenQLC = null;

    // Try each QLC size to see if we can meet capacity with minimum D boxes
    for (let qlcSize of qlcSizes) {
        const capacityPerDBox = scmCapacityPerDBox + (qlcSize * qlcCount);
        const requiredDBoxes = Math.ceil(totalCapacityTB / capacityPerDBox);

        if (requiredDBoxes <= pricing.min_d_boxes) {
            chosenQLC = qlcSize;
            dBoxesForCapacity = pricing.min_d_boxes;
            break;
        }
    }

    // If no QLC size works with minimum D boxes, use smallest QLC and scale D boxes
    if (!chosenQLC) {
        chosenQLC = qlcSizes[0]; // Start with smallest
        const capacityPerDBox = scmCapacityPerDBox + (chosenQLC * qlcCount);
        dBoxesForCapacity = Math.ceil(totalCapacityTB / capacityPerDBox);

        // If even the largest QLC can't do it with calculated D boxes, increase count
        const largestQLC = qlcSizes[qlcSizes.length - 1];
        const maxCapacityPerDBox = scmCapacityPerDBox + (largestQLC * qlcCount);
        const minDBoxesNeeded = Math.ceil(totalCapacityTB / maxCapacityPerDBox);

        if (dBoxesForCapacity < minDBoxesNeeded) {
            dBoxesForCapacity = minDBoxesNeeded;
            chosenQLC = largestQLC;
        }
    }

    // C boxes are defined by performance requirement
    const cBoxes = Math.max(cBoxesForPerformance, pricing.min_c_boxes);

    // D boxes must be at least equal to C boxes (can't have more C than D)
    // Also must meet capacity requirement
    const dBoxes = Math.max(dBoxesForCapacity, cBoxes, pricing.min_d_boxes);

    // Re-check if chosen QLC still works with the final D box count
    const capacityWithChosenQLC = dBoxes * (scmCapacityPerDBox + (chosenQLC * qlcCount));
    if (capacityWithChosenQLC < totalCapacityTB) {
        // Need to upgrade to larger QLC
        for (let qlcSize of qlcSizes) {
            const testCapacity = dBoxes * (scmCapacityPerDBox + (qlcSize * qlcCount));
            if (testCapacity >= totalCapacityTB) {
                chosenQLC = qlcSize;
                break;
            }
        }
        // If still not enough, use largest QLC available
        if (capacityWithChosenQLC < totalCapacityTB) {
            chosenQLC = qlcSizes[qlcSizes.length - 1];
        }
    }

    // Calculate costs
    const cBoxCost = cBoxes * pricing.c_box.base_cost;
    const dBoxBaseCost = dBoxes * pricing.d_box.base_cost;
    const scmCost = dBoxes * pricing.d_box.scm_drives.count * pricing.d_box.scm_drives.cost_per_drive;
    const qlcSSDCost = dBoxes * qlcCount * pricing.d_box.qlc_ssds[chosenQLC + 'TB'];

    const hardwareCost = cBoxCost + dBoxBaseCost + scmCost + qlcSSDCost;

    // Software and support is 55% of total cost
    const softwareCost = hardwareCost * pricing.software_support_multiplier;
    const subtotal = hardwareCost + softwareCost;

    // Add 15% partner margin
    const totalCost = subtotal * 1.15;

    // Calculate actual capacity
    const actualCapacity = dBoxes * (scmCapacityPerDBox + (chosenQLC * qlcCount));

    // Calculate performance based on C boxes
    const performanceGBs = cBoxes * performancePerCBox;

    return {
        nodes: cBoxes + dBoxes,
        cBoxes: cBoxes,
        dBoxes: dBoxes,
        ssdSize: chosenQLC,
        ssdBandwidth: performanceGBs,
        ssdCapacity: actualCapacity,
        totalCost: totalCost
    };
}

// Calculate VDURA system cost
function calculateVDURACost(vdura, pricing) {
    // VELO costs
    const veloCost = vdura.velos * pricing.velo_director.base_cost;
    const veloSSDCost = vdura.velos * pricing.ssds_per_velo * pricing.ssds[pricing.velo_ssd_size];
    const veloDRAMCost = vdura.velos * pricing.velo_director.dram_gb * pricing.dram_price_per_gb;

    // VPOD costs
    const vpodCost = vdura.vpods * pricing.vpod_server.base_cost;
    const vpodSSDCost = vdura.vpods * pricing.ssds_per_vpod * pricing.ssds[vdura.ssdSize + 'TB'];
    const vpodDRAMCost = vdura.vpods * pricing.vpod_server.dram_gb * pricing.dram_price_per_gb;

    // JBOD costs
    const jbodCost = vdura.jbods * pricing.jbod_4u108.cost;

    const hardwareCost = veloCost + veloSSDCost + veloDRAMCost + vpodCost + vpodSSDCost + vpodDRAMCost + jbodCost;

    // Software and support is 50% of total cost (hardware = 50%)
    const softwareCost = hardwareCost * pricing.software_support_multiplier;
    const subtotal = hardwareCost + softwareCost;

    // Add 15% partner margin
    const totalCost = subtotal * 1.15;

    return totalCost;
}

// Update migration arrows
function updateMigrationArrows(numJBODs, vduraBandwidth, competitorBandwidth) {
    const JBOD_BANDWIDTH = 21.5; // GB/s per JBOD

    // VDURA: Create one arrow per JBOD (or show message if 100% SSD)
    const vduraContainer = document.getElementById('vdura-migration-container');
    let vduraHTML = '';
    if (numJBODs === 0) {
        vduraHTML = '<div class="no-migration-message">100% SSD - No HDD Tier</div>';
    } else {
        for (let i = 0; i < numJBODs; i++) {
            vduraHTML += `
                <div class="migration-arrow-vertical">
                    <svg class="arrow-svg-vertical" viewBox="0 0 40 80">
                        <defs>
                            <marker id="arrowhead-vdura-${i}" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto">
                                <polygon points="0 0, 8 4, 0 8" fill="#e79f23" />
                            </marker>
                        </defs>
                        <path d="M 20 10 L 20 66" stroke="#e79f23" stroke-width="3" fill="none" marker-end="url(#arrowhead-vdura-${i})" />
                    </svg>
                    <div class="arrow-label-vertical">JBOD ${i + 1}<br><span class="bandwidth-highlight">${JBOD_BANDWIDTH} GB/s</span></div>
                </div>
            `;
        }
    }
    vduraContainer.innerHTML = vduraHTML;

    // Hide/show VDURA migration note based on whether HDD tier exists
    const vduraNoteEl = document.querySelector('.vdura-note-text');
    if (vduraNoteEl) {
        vduraNoteEl.style.display = numJBODs === 0 ? 'none' : 'block';
    }

    // Competitor: Single S3 arrow
    const competitorContainer = document.getElementById('competitor-migration-container');
    competitorContainer.innerHTML = `
        <div class="migration-arrow-vertical">
            <svg class="arrow-svg-vertical" viewBox="0 0 40 80">
                <defs>
                    <marker id="arrowhead-comp" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto">
                        <polygon points="0 0, 8 4, 0 8" fill="#ef4444" />
                    </marker>
                </defs>
                <path d="M 20 10 L 20 66" stroke="#ef4444" stroke-width="3" fill="none" marker-end="url(#arrowhead-comp)" stroke-dasharray="6,6" />
            </svg>
            <div class="arrow-label-vertical"><span class="bandwidth-highlight">5 GB/s</span> S3</div>
        </div>
    `;
}

// Animation system for continuous checkpoint flow
function startAnimation() {
    // Clear any existing animation
    if (animationInterval) {
        clearInterval(animationInterval);
    }

    // Seed with initial checkpoints for immediate visual feedback
    seedInitialCheckpoints();

    // Animation runs every 500ms (0.5 seconds) for smoother visuals
    const FRAME_INTERVAL_MS = 500;
    const FRAME_INTERVAL_MINUTES = FRAME_INTERVAL_MS / 60000; // Convert to minutes

    // Speed up time so checkpoint arrives every ~1 second real time
    // Example: 60 min interval → 60 simulated min per 1 real sec → each 0.5s frame = 30 simulated min
    const TIME_ACCELERATION = workflowParams.checkpointInterval * 60;

    animationInterval = setInterval(() => {
        animateCheckpointFlow(FRAME_INTERVAL_MINUTES * TIME_ACCELERATION);
    }, FRAME_INTERVAL_MS);
}

function seedInitialCheckpoints() {
    // Reset animation state - start completely empty
    animationState.vdura = {
        checkpoints: [],
        nextCheckpointId: 1,
        timeSinceLastCheckpoint: workflowParams.checkpointInterval * 0.9, // Nearly ready for first checkpoint
        ssdFull: false
    };
    animationState.competitor = {
        checkpoints: [],
        nextCheckpointId: 1,
        timeSinceLastCheckpoint: workflowParams.checkpointInterval * 0.9,
        ssdFull: false
    };

    // Start with completely empty tiers - no initial checkpoints
    // This shows the systems filling up over time

    // Render initial state
    renderCheckpoints();
}

function animateCheckpointFlow(deltaMinutes) {
    // Update time since last checkpoint
    animationState.vdura.timeSinceLastCheckpoint += deltaMinutes;
    animationState.competitor.timeSinceLastCheckpoint += deltaMinutes;

    // Add new checkpoints when interval is reached
    if (animationState.vdura.timeSinceLastCheckpoint >= workflowParams.checkpointInterval) {
        addCheckpoint('vdura');
        animationState.vdura.timeSinceLastCheckpoint = 0;
    }

    if (animationState.competitor.timeSinceLastCheckpoint >= workflowParams.checkpointInterval) {
        addCheckpoint('competitor');
        animationState.competitor.timeSinceLastCheckpoint = 0;
    }

    // Update checkpoint states (migrating progress)
    updateCheckpointStates('vdura', deltaMinutes);
    updateCheckpointStates('competitor', deltaMinutes);

    // Render the visualization
    renderCheckpoints();
}

function addCheckpoint(system) {
    const state = animationState[system];
    const config = systemConfigs[system];

    // Check if SSD is full
    const activeCheckpoints = state.checkpoints.filter(cp => cp.status === 'active');
    const migratingCheckpoints = state.checkpoints.filter(cp => cp.status === 'migrating');
    const totalInSSD = activeCheckpoints.length + migratingCheckpoints.length;
    const ssdCapacity = config.ssdCapacity;
    const checkpointSize = workflowParams.checkpointSize;
    const maxCheckpointsInSSD = Math.floor(ssdCapacity / checkpointSize);

    // If SSD is full, mark system as full and don't add checkpoint
    if (totalInSSD >= maxCheckpointsInSSD) {
        state.ssdFull = true;
        return; // Can't add checkpoint - SSD is full!
    } else {
        state.ssdFull = false;
    }

    state.checkpoints.push({
        id: state.nextCheckpointId++,
        status: 'active', // 'active', 'migrating', 'archived'
        migrationProgress: 0 // 0-100%
    });

    // Check if we should start a migration
    // Only one checkpoint can migrate at a time (single migration pipeline)
    const targetSSDCheckpoints = workflowParams.numCheckpoints;
    const hddCapacity = system === 'vdura' ? config.hddCapacity : config.s3Capacity;

    // Only migrate if there's HDD/S3 capacity available
    if (hddCapacity > 0) {
        // If no migration in progress and we exceed target, start migrating oldest
        if (migratingCheckpoints.length === 0 && activeCheckpoints.length + 1 > targetSSDCheckpoints) {
            const oldestActive = activeCheckpoints.sort((a, b) => a.id - b.id)[0];
            if (oldestActive) {
                oldestActive.status = 'migrating';
                oldestActive.migrationProgress = 0;
            }
        }
    }

    // If system can't keep up with migration speed, checkpoints pile up in SSD
}

function updateCheckpointStates(system, deltaMinutes) {
    const state = animationState[system];
    const migrationTime = system === 'vdura' ?
        workflowParams.vduraMigrationTime :
        workflowParams.competitorMigrationTime;

    let migrationCompleted = false;

    state.checkpoints.forEach(checkpoint => {
        if (checkpoint.status === 'migrating') {
            // Update migration progress
            const progressPerMinute = (100 / migrationTime);
            checkpoint.migrationProgress += progressPerMinute * deltaMinutes;

            if (checkpoint.migrationProgress >= 100) {
                checkpoint.status = 'archived';
                checkpoint.migrationProgress = 100;
                migrationCompleted = true;
            }
        }
    });

    // If a migration just completed, start the next one if available
    if (migrationCompleted) {
        const activeCheckpoints = state.checkpoints.filter(cp => cp.status === 'active');
        const targetSSDCheckpoints = workflowParams.numCheckpoints;

        if (activeCheckpoints.length > targetSSDCheckpoints) {
            const oldestActive = activeCheckpoints.sort((a, b) => a.id - b.id)[0];
            if (oldestActive) {
                oldestActive.status = 'migrating';
                oldestActive.migrationProgress = 0;
            }
        }
    }

    // Keep archived checkpoints - don't remove them
    // Let the HDD/S3 tier fill up to show the migration working
    // When JBOD fills up, restart the simulation
    const config = systemConfigs[system];
    const archivedCheckpoints = state.checkpoints.filter(cp => cp.status === 'archived');
    const hddCapacity = system === 'vdura' ? config.hddCapacity : config.s3Capacity;
    const maxArchivedCheckpoints = Math.floor(hddCapacity / workflowParams.checkpointSize);

    // Check if HDD/S3 tier is full - restart simulation when it fills
    // Skip if no HDD capacity (100% SSD)
    if (hddCapacity > 0 && archivedCheckpoints.length >= maxArchivedCheckpoints) {
        // Only restart once both systems have filled (to keep them synchronized)
        const vduraArchived = animationState.vdura.checkpoints.filter(cp => cp.status === 'archived').length;
        const competitorArchived = animationState.competitor.checkpoints.filter(cp => cp.status === 'archived').length;
        const vduraMaxArchived = Math.floor(systemConfigs.vdura.hddCapacity / workflowParams.checkpointSize);
        const competitorMaxArchived = Math.floor(systemConfigs.competitor.s3Capacity / workflowParams.checkpointSize);

        if (vduraArchived >= vduraMaxArchived && competitorArchived >= competitorMaxArchived) {
            // Both tiers are full - restart the simulation
            console.log('Both Tier 2 storage tiers full - restarting simulation');
            setTimeout(() => {
                seedInitialCheckpoints();
            }, 1000); // Brief pause before restart for visual effect
        }
    }
}

function renderCheckpoints() {
    // Debug checkpoint states every 5 seconds
    if (!renderCheckpoints.lastLog || Date.now() - renderCheckpoints.lastLog > 5000) {
        console.log('Animation state:');
        console.log('  VDURA: active=' + animationState.vdura.checkpoints.filter(cp => cp.status === 'active').length +
                    ', migrating=' + animationState.vdura.checkpoints.filter(cp => cp.status === 'migrating').length +
                    ', archived=' + animationState.vdura.checkpoints.filter(cp => cp.status === 'archived').length +
                    ', ssdFull=' + animationState.vdura.ssdFull);
        console.log('  Competitor: active=' + animationState.competitor.checkpoints.filter(cp => cp.status === 'active').length +
                    ', migrating=' + animationState.competitor.checkpoints.filter(cp => cp.status === 'migrating').length +
                    ', archived=' + animationState.competitor.checkpoints.filter(cp => cp.status === 'archived').length +
                    ', ssdFull=' + animationState.competitor.ssdFull);
        renderCheckpoints.lastLog = Date.now();
    }

    renderSystemCheckpoints('vdura');
    renderSystemCheckpoints('competitor');
}

function renderSystemCheckpoints(system) {
    const state = animationState[system];
    const ssdContainer = document.getElementById(`${system}-checkpoints`);
    const archivedContainer = document.getElementById(`${system}-archived`);

    // Get tier capacities from stored configs
    const config = systemConfigs[system];
    if (!config || !config.ssdCapacity) {
        return; // Not initialized yet
    }

    // Show/hide SSD full warning (as overlay)
    const warningId = `${system}-ssd-full-warning`;
    let warningEl = document.getElementById(warningId);
    if (state.ssdFull) {
        if (!warningEl) {
            // Create warning element if it doesn't exist
            warningEl = document.createElement('div');
            warningEl.id = warningId;
            warningEl.className = 'ssd-full-warning';
            warningEl.innerHTML = '⚠️ SSD FULL - System Cannot Accept New Checkpoints!';
            // Append to the storage box parent for overlay positioning
            const storageBox = ssdContainer.closest('.storage-box');
            if (storageBox) {
                storageBox.style.position = 'relative'; // Ensure parent is positioned
                storageBox.appendChild(warningEl);
            }
        }
        warningEl.style.display = 'flex';
    } else if (warningEl) {
        warningEl.style.display = 'none';
    }

    const checkpointSize = workflowParams.checkpointSize;

    // Calculate grid sizes (each cell = 1 checkpoint)
    const ssdCapacity = config.ssdCapacity;
    const hddCapacity = system === 'vdura' ? config.hddCapacity : config.s3Capacity;

    const ssdCells = Math.floor(ssdCapacity / checkpointSize);
    const hddCells = Math.floor(hddCapacity / checkpointSize);

    // Sort checkpoints by ID for display
    const activeCheckpoints = state.checkpoints.filter(cp => cp.status === 'active').sort((a, b) => b.id - a.id);
    const migratingCheckpoints = state.checkpoints.filter(cp => cp.status === 'migrating').sort((a, b) => b.id - a.id);
    const archivedCheckpoints = state.checkpoints.filter(cp => cp.status === 'archived').sort((a, b) => b.id - a.id);

    const ssdFilled = activeCheckpoints.length + migratingCheckpoints.length;
    const hddFilled = archivedCheckpoints.length;

    // Combine active and migrating for SSD display
    const ssdCheckpoints = [...migratingCheckpoints, ...activeCheckpoints];

    // Build SSD grid with checkpoint IDs
    let ssdHTML = '<div class="capacity-grid">';
    for (let i = 0; i < ssdCells; i++) {
        if (i < ssdFilled) {
            const checkpoint = ssdCheckpoints[i];
            const isMigrating = i < migratingCheckpoints.length;
            const className = isMigrating ? 'grid-cell filled migrating' : 'grid-cell filled';
            ssdHTML += `<div class="${className}">${checkpoint.id}</div>`;
        } else {
            ssdHTML += `<div class="grid-cell empty"></div>`;
        }
    }
    ssdHTML += '</div>';

    // Build HDD/S3 grid with checkpoint IDs
    let hddHTML = '<div class="capacity-grid">';
    for (let i = 0; i < hddCells; i++) {
        if (i < hddFilled) {
            const checkpoint = archivedCheckpoints[i];
            hddHTML += `<div class="grid-cell filled archived">${checkpoint.id}</div>`;
        } else {
            hddHTML += `<div class="grid-cell empty"></div>`;
        }
    }
    hddHTML += '</div>';

    // Update DOM
    if (ssdContainer.innerHTML !== ssdHTML) {
        ssdContainer.innerHTML = ssdHTML;
    }
    if (archivedContainer.innerHTML !== hddHTML) {
        archivedContainer.innerHTML = hddHTML;
    }
}
