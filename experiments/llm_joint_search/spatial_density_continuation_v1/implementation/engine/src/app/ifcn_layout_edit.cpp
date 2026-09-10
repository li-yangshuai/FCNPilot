// Apply explicit coordinate edits to a fixed DAG, then reroute that placement.
// This emits a candidate, never a replacement for the baseline or a signoff.
#include <autopr/algorithms/astar.h>
#include <autopr/algorithms/mapping.h>
#include <autopr/graph/circuitGraph.h>
#include <autopr/graph/parse.h>
#include <boost/json/src.hpp>
#include <algorithm>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>

namespace {
using namespace fcngraph;
namespace json = boost::json;

int integer(const json::value &value, int minimum, int maximum) {
    if (!value.is_int64() || value.as_int64() < minimum || value.as_int64() > maximum)
        throw std::invalid_argument("integer outside the permitted range");
    return static_cast<int>(value.as_int64());
}
std::string string(const json::value &value) {
    if (!value.is_string()) throw std::invalid_argument("expected JSON string");
    return std::string(value.as_string());
}
json::object readObject(const std::filesystem::path &path) {
    if (std::filesystem::file_size(path) > 16 * 1024 * 1024)
        throw std::invalid_argument("candidate/proposal file exceeds 16 MiB");
    std::ifstream in(path);
    if (!in) throw std::runtime_error("cannot read " + path.string());
    std::ostringstream buffer; buffer << in.rdbuf();
    return json::parse(buffer.str()).as_object();
}
void requireKeys(const json::object &object, const std::set<std::string> &allowed) {
    for (const auto &field : object)
        if (!allowed.count(std::string(field.key())))
            throw std::invalid_argument("unsupported proposal field: " + std::string(field.key()));
}
json::array jsonPoint(position pos) { return {pos.first, pos.second}; }
using Edge = std::pair<unsigned int, unsigned int>;
using Routes = std::map<Edge, std::vector<position>>;
Routes readRoutes(const json::array &values) {
    Routes routes;
    for (const auto &value : values) {
        const auto &item = value.as_object();
        const Edge edge{integer(item.at("source"), 0, 1000000), integer(item.at("target"), 0, 1000000)};
        std::vector<position> path;
        for (const auto &coordinate : item.at("path").as_array()) {
            const auto &p = coordinate.as_array();
            if (p.size() != 2) throw std::invalid_argument("invalid route point");
            path.emplace_back(integer(p[0], 0, 4095), integer(p[1], 0, 4095));
        }
        if (!routes.emplace(edge, std::move(path)).second)
            throw std::invalid_argument("duplicate baseline route");
    }
    return routes;
}
json::array routePoints(const std::vector<position> &path) {
    json::array out; for (auto p : path) out.push_back(jsonPoint(p)); return out;
}

std::size_t validatePhysicalMapping(Parse &parse, const CircuitGraph &graph) {
    NodeLinkMap links;
    for (const auto &node : graph.nodeIndex_pos)
        links[{node.second, parse.getNodeType(node.first)}] = {{}, {}};
    std::set<Edge> expected;
    for (auto edge : parse.getEffectiveEdges()) expected.emplace(edge.first, edge.second);
    if (expected.size() != graph.routes.size()) throw std::runtime_error("incomplete routed edge coverage");
    std::vector<std::vector<position>> paths;
    for (const auto &[edge, path] : graph.routes) {
        if (!expected.count(edge) || path.size() < 2 ||
            path.front() != graph.nodeIndex_pos.at(edge.first) ||
            path.back() != graph.nodeIndex_pos.at(edge.second))
            throw std::runtime_error("route endpoint/DAG mismatch");
        links[{path.front(), parse.getNodeType(edge.first)}].second.push_back(path[1]);
        auto &fanin = links[{path.back(), parse.getNodeType(edge.second)}].first;
        if (std::find(fanin.begin(), fanin.end(), path[path.size() - 2]) != fanin.end())
            throw std::runtime_error("fanins share a physical gate port");
        fanin.push_back(path[path.size() - 2]); paths.push_back(path);
    }
    for (auto &[node, ports] : links) {
        (void)node;
        for (auto *list : {&ports.first, &ports.second}) {
            std::sort(list->begin(), list->end());
            list->erase(std::unique(list->begin(), list->end()), list->end());
        }
    }
    Mapping mapping;
    mapping.node_mapping(links, MappingMode::Combinational);
    mapping.mapping_line(paths, MappingMode::Combinational);
    std::string error;
    if (!mapping.validate_crossovers(&error)) throw std::runtime_error(error);
    const auto ordered = mapping.orderedLayerAwarePhysicalRoutes(paths);
    std::set<position> nodeCells;
    for (const auto &bucket : mapping.nodecell_list)
        nodeCells.insert(bucket.second.begin(), bucket.second.end());
    for (const auto &path : ordered)
        if (!nodeCells.count(path.front().xy) || !nodeCells.count(path.back().xy))
            throw std::runtime_error("physical route is missing its template port");
    return mapping.physicalCellSites(paths).size();
}
} // namespace

int main(int argc, char **argv) {
    try {
        if (argc < 5) {
            std::cerr << "Usage: ifcn_layout_edit <normalized.v> <baseline.json> <proposal.json> <candidate.json> "
                         "[--route-retries 24] [--search-cost 40] [--padding 2] [--lock-io]\n";
            return 2;
        }
        int retries = 24, padding = 2, searchCost = -1;
        bool lockIo = false;
        for (int arg = 5; arg < argc; ++arg) {
            const std::string option = argv[arg];
            if (option == "--lock-io") { lockIo = true; continue; }
            if (arg + 1 >= argc) throw std::invalid_argument("missing option value");
            const std::string text = argv[++arg];
            if (text.empty() || text.find_first_not_of("0123456789") != std::string::npos)
                throw std::invalid_argument("expected nonnegative integer option");
            const int value = std::stoi(text);
            if (option == "--route-retries" && value <= 64) retries = value;
            else if (option == "--padding" && value <= 8) padding = value;
            else if (option == "--search-cost" && value >= 1 && value <= 240) searchCost = value;
            else throw std::invalid_argument("unknown or out-of-range routing option");
        }
        if (std::filesystem::exists(argv[4]))
            throw std::invalid_argument("output already exists; baseline/results must never be overwritten");
        const auto baseline = readObject(argv[2]);
        const auto proposal = readObject(argv[3]);
        const std::string proposalSchema = string(proposal.at("schema"));
        const bool searchV2 = proposalSchema == "ifcn.layout_search.v2";
        if (!searchV2 && proposalSchema != "ifcn.layout_edit.v1")
            throw std::invalid_argument("unknown proposal schema");
        requireKeys(proposal, searchV2
            ? std::set<std::string>{"schema", "operations", "routing_order", "rationale"}
            : std::set<std::string>{"schema", "operations", "rationale"});
        if (searchV2)
            for (const auto *key : {"schema", "operations", "routing_order", "rationale"})
                if (!proposal.if_contains(key))
                    throw std::invalid_argument(std::string("v2 proposal requires ") + key);
        if (proposal.if_contains("rationale")) static_cast<void>(string(proposal.at("rationale")));
        const auto &operations = proposal.at("operations").as_array();
        if (operations.size() > 8) throw std::invalid_argument("at most eight coordinate edits are permitted");
        const bool explicitRoutingOrder = searchV2 && !proposal.at("routing_order").is_null();
        if (searchV2 && operations.empty() && !explicitRoutingOrder)
            throw std::invalid_argument("v2 requires coordinate edits or an explicit routing_order");
        const std::string algorithm = string(baseline.at("algorithm"));
        const std::string topology = string(baseline.at("topology"));
        if (string(baseline.at("schema")) != "ifcn.native_candidate.v1" ||
            (algorithm != "june_random" && algorithm != "compact") ||
            (topology != "optimized_buffers" && topology != "layer_redundancy_buffers") ||
            (algorithm == "compact" && topology != "optimized_buffers"))
            throw std::invalid_argument("only the existing Compact/June irregular-clock topologies are supported");
        // Rephasing invalidates the old native_mapping_valid flag. The caller
        // verifies the baseline's fresh clock/QCA certificates; this interface
        // reconstructs and validates the edited geometry independently below.
        if (!baseline.at("routed").as_bool())
            throw std::invalid_argument("baseline must contain a routed placement");
        if (searchCost < 0) searchCost = algorithm == "compact" ? 240 : 40;
        Parse parse;
        parse.parseVerilog(argv[1]);
        if (!parse.get_input_num() || !parse.get_output_num())
            throw std::invalid_argument("source requires primary inputs and outputs");
        parse.optimizeAIOG_DRC(2, 2, 2, 2, 2, 2);
        if (topology == "layer_redundancy_buffers") parse.addLayerRedundancyNode();
        else parse.optimizeBufferNode();
        parse.caculateSameLayerNodeRoutePair();
        std::set<int> expectedNodes;
        json::array layers;
        for (const auto &layer : parse.getlayerNodeDivVec()) {
            json::array members;
            for (int node : layer) { expectedNodes.insert(node); members.push_back(node); }
            layers.push_back(std::move(members));
        }
        if (expectedNodes.empty() || expectedNodes.size() > 128)
            throw std::invalid_argument("bounded edit interface supports 1..128 effective nodes");
        std::map<int, position> before;
        std::set<int> ioNodes;
        for (const auto &value : baseline.at("nodes").as_array()) {
            const auto &node = value.as_object();
            const int id = integer(node.at("id"), 0, 1000000);
            if (!expectedNodes.count(id)) throw std::invalid_argument("baseline has an unknown DAG node");
            const bool input = parse.getNodeType(id) == "input";
            const bool output = parse.getOutputNodesIndex().count(id) != 0;
            if (string(node.at("name")) != parse.getNodeName(id) ||
                string(node.at("type")) != parse.getNodeType(id) ||
                node.at("is_input").as_bool() != input || node.at("is_output").as_bool() != output)
                throw std::invalid_argument("baseline node identity/type differs from the source DAG");
            if (input || output) ioNodes.insert(id);
            if (!before.emplace(id, position{integer(node.at("x"), 0, 4095), integer(node.at("y"), 0, 4095)}).second)
                throw std::invalid_argument("duplicate baseline node");
        }
        if (before.size() != expectedNodes.size()) throw std::invalid_argument("baseline omits DAG nodes");
        std::set<Edge> expectedEdges, declaredEdges;
        for (auto edge : parse.getEffectiveEdges()) expectedEdges.emplace(edge.first, edge.second);
        for (const auto &value : baseline.at("edges").as_array()) {
            const auto &edge = value.as_array();
            if (edge.size() != 2 || !declaredEdges.emplace(integer(edge[0], 0, 1000000), integer(edge[1], 0, 1000000)).second)
                throw std::invalid_argument("invalid or duplicate baseline edge");
        }
        if (declaredEdges != expectedEdges) throw std::invalid_argument("baseline DAG edges differ from source");
        std::vector<std::pair<int, int>> requestedOrder;
        if (explicitRoutingOrder) {
            const auto &value = proposal.at("routing_order");
            if (!value.is_array()) throw std::invalid_argument("routing_order must be null or an array of DAG edges");
            std::set<Edge> uniqueOrder;
            for (const auto &item : value.as_array()) {
                if (!item.is_array() || item.as_array().size() != 2)
                    throw std::invalid_argument("routing_order entries must be source/target pairs");
                const auto &pair = item.as_array();
                const int a = integer(pair[0], 0, 1000000), b = integer(pair[1], 0, 1000000);
                const Edge edge{a, b};
                if (!expectedEdges.count(edge) || !uniqueOrder.insert(edge).second)
                    throw std::invalid_argument("routing_order has an unknown or duplicate DAG edge");
                requestedOrder.emplace_back(a, b);
            }
            if (uniqueOrder != expectedEdges)
                throw std::invalid_argument("routing_order must contain every DAG edge exactly once");
        }
        const Routes oldRoutes = readRoutes(baseline.at("routes").as_array());
        if (oldRoutes.size() != expectedEdges.size()) throw std::invalid_argument("baseline route coverage differs from DAG");
        for (const auto &[edge, path] : oldRoutes)
            if (!expectedEdges.count(edge) || path.size() < 2 || path.front() != before.at(edge.first) || path.back() != before.at(edge.second))
                throw std::invalid_argument("baseline route endpoints differ from node placement");
        int minX = 4095, minY = 4095, maxX = 0, maxY = 0;
        const auto includeBounds = [&](position p) {
            minX = std::min(minX, static_cast<int>(p.first)); maxX = std::max(maxX, static_cast<int>(p.first));
            minY = std::min(minY, static_cast<int>(p.second)); maxY = std::max(maxY, static_cast<int>(p.second));
        };
        for (const auto &[id, p] : before) { (void)id; includeBounds(p); }
        for (const auto &[edge, path] : oldRoutes) { (void)edge; for (auto p : path) includeBounds(p); }
        minX = std::max(0, minX - padding); minY = std::max(0, minY - padding);
        maxX = std::min(4095, maxX + padding); maxY = std::min(4095, maxY + padding);
        auto requested = before;
        const auto movable = [&](const json::value &value) {
            const int id = integer(value, 0, 1000000);
            if (!requested.count(id)) throw std::invalid_argument("edit references an unknown node");
            if (lockIo && ioNodes.count(id)) throw std::invalid_argument("I/O node is locked by experiment policy");
            return id;
        };
        std::set<int> touchedV2;
        const auto recordTouch = [&](int id) {
            if (searchV2 && !touchedV2.insert(id).second)
                throw std::invalid_argument("v2 edits may touch each node at most once");
        };
        for (const auto &value : operations) {
            const auto &operation = value.as_object();
            const std::string op = string(operation.at("op"));
            if (op == "move") {
                requireKeys(operation, {"op", "node", "to"});
                const int id = movable(operation.at("node"));
                recordTouch(id);
                const auto &to = operation.at("to").as_array();
                if (to.size() != 2) throw std::invalid_argument("move requires an XY destination");
                const position destination{integer(to[0], minX, maxX), integer(to[1], minY, maxY)};
                if (searchV2 && requested.at(id) == destination)
                    throw std::invalid_argument("v2 move must change the node position");
                requested[id] = destination;
            } else if (op == "swap") {
                requireKeys(operation, {"op", "nodes"});
                const auto &nodes = operation.at("nodes").as_array();
                if (nodes.size() != 2) throw std::invalid_argument("swap requires two node IDs");
                const int a = movable(nodes[0]), b = movable(nodes[1]);
                if (a == b) throw std::invalid_argument("swap requires distinct node IDs");
                recordTouch(a); recordTouch(b);
                std::swap(requested.at(a), requested.at(b));
            } else throw std::invalid_argument("only move and swap coordinate operations are supported");
        }
        std::set<position> occupied;
        for (const auto &[id, p] : requested) {
            (void)id;
            if (!occupied.insert(p).second) throw std::invalid_argument("edited placement contains a node collision");
        }
        GridChessboard board;
        Astar router(board, false, searchCost);
        router.setAllowInterSourceWireOverlap(false);
        if (algorithm == "compact") router.setOccupiedWirePenalty(0.0);
        CircuitGraph graph(parse, argv[1], board, router);
        graph.nodeIndex_pos = requested;
        graph.setFitnessCallback([](const std::string &message) { std::cerr << message << '\n'; });
        const auto start = std::chrono::steady_clock::now();
        bool routed = false;
        std::size_t physicalCells = 0;
        const int maxSamePhase = algorithm == "compact" ? 4 : 10;
        int actualMaxSamePhase = 0, samePhaseSteps = 0, totalSteps = 0;
        bool clockRulesPassed = false;
        std::string error;
        try {
            routed = graph.routeProvidedIrregularPlacement(
                4, retries, maxSamePhase, explicitRoutingOrder ? &requestedOrder : nullptr);
            if (!routed) throw std::runtime_error("edited placement could not be routed under the original clock/geometry rules");
            for (const auto &[edge, path] : graph.routes) {
                (void)edge;
                int previous = -1, run = 0;
                for (const auto &p : path) {
                    const int phase = board.gridMap.at(p).getPhase();
                    if (phase < 1 || phase > 4) throw std::runtime_error("rerouted cell phase is outside 1..4");
                    if (previous >= 0) {
                        ++totalSteps;
                        if (phase == previous) ++samePhaseSteps;
                        else if ((phase - previous + 4) % 4 != 1)
                            throw std::runtime_error("rerouted phase must hold or advance one phase");
                    }
                    run = phase == previous ? run + 1 : 1;
                    actualMaxSamePhase = std::max(actualMaxSamePhase, run);
                    previous = phase;
                }
            }
            if (actualMaxSamePhase > maxSamePhase ||
                (algorithm == "june_random" && samePhaseSteps * 10 > totalSteps * 3))
                throw std::runtime_error("rerouting violates the baseline algorithm's same-phase clock constraints");
            clockRulesPassed = true;
            physicalCells = validatePhysicalMapping(parse, graph);
        } catch (const std::exception &exception) { error = exception.what(); }
        if (graph.nodeIndex_pos != requested) throw std::runtime_error("router silently changed requested placement");
        json::object result{{"schema", "ifcn.native_candidate.v1"}, {"algorithm", algorithm},
            {"clock_scheme", "irregular"}, {"topology", topology}, {"routed", routed},
            {"native_mapping_valid", routed && error.empty()}, {"native_validation_error", error},
            {"run_time_s", std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count()},
            {"layers", layers}};
        json::array nodes, edges, routes, cells, nodeChanges, routeChanges;
        for (const auto &[id, p] : graph.nodeIndex_pos) {
            nodes.push_back(json::object{{"id", id}, {"name", parse.getNodeName(id)},
                {"type", parse.getNodeType(id)}, {"is_input", parse.getNodeType(id) == "input"},
                {"is_output", parse.getOutputNodesIndex().count(id) != 0}, {"x", p.first}, {"y", p.second}});
            if (before.at(id) != p) nodeChanges.push_back(json::object{{"node", id}, {"name", parse.getNodeName(id)},
                {"from", jsonPoint(before.at(id))}, {"to", jsonPoint(p)}});
        }
        for (auto edge : expectedEdges) edges.push_back(json::array{edge.first, edge.second});
        for (const auto &[edge, path] : graph.routes)
            routes.push_back(json::object{{"source", edge.first}, {"target", edge.second}, {"path", routePoints(path)}});
        for (const auto &[edge, path] : oldRoutes) {
            const auto found = graph.routes.find(edge);
            if (found == graph.routes.end() || found->second != path)
                routeChanges.push_back(json::object{{"source", edge.first}, {"target", edge.second},
                    {"before", routePoints(path)}, {"after", found == graph.routes.end() ? json::array{} : routePoints(found->second)}});
        }
        for (const auto &[p, cell] : board.gridMap)
            if (cell.get_current_weight() != 0) cells.push_back(json::object{{"x", p.first}, {"y", p.second}, {"phase", cell.getPhase()}});
        result["nodes"] = std::move(nodes); result["edges"] = std::move(edges);
        result["routes"] = std::move(routes); result["cells"] = std::move(cells);
        result["expansion"] = json::object{{"inserted_rows", 0}, {"inserted_columns", 0},
            {"accepted_rounds", 0}, {"evaluated_cut_candidates", 0}, {"reused_routed_candidates", 0}};
        const auto &routingTrace = graph.getRoutingOrderTrace();
        json::array requestedOrderJson, executedOrderJson;
        for (auto edge : routingTrace.requestedOrder) requestedOrderJson.push_back(json::array{edge.first, edge.second});
        for (auto edge : routingTrace.executedOrder) executedOrderJson.push_back(json::array{edge.first, edge.second});
        result["edit"] = json::object{{"schema", searchV2 ? "ifcn.layout_search_result.v2" : "ifcn.layout_edit_result.v1"}, {"proposal", proposal},
            {"explicit_routing_order", routingTrace.explicitOrder},
            {"requested_order", explicitRoutingOrder ? json::value(requestedOrderJson) : json::value(nullptr)},
            {"executed_order", executedOrderJson}, {"route_order_attempts", routingTrace.attempts},
            {"fallback_used", routingTrace.fallbackUsed},
            {"node_changes", nodeChanges}, {"route_changes", routeChanges},
            {"changed_node_count", nodeChanges.size()}, {"changed_route_count", routeChanges.size()},
            {"dag_preserved", true}, {"clock_family_preserved", true}, {"coordinates_preserved_exactly", true},
            {"coordinate_translation", json::array{0, 0}}, {"io_locked", lockIo},
            {"bounds", json::object{{"min_x", minX}, {"max_x", maxX}, {"min_y", minY}, {"max_y", maxY}, {"padding", padding}}},
            {"route_retries", retries}, {"max_search_cost", searchCost}, {"native_physical_cell_count", physicalCells},
            {"clock_constraints", json::object{{"passed", clockRulesPassed}, {"max_same_phase_tiles", maxSamePhase},
                {"max_same_phase_step_fraction", algorithm == "june_random" ? json::value(0.3) : json::value(nullptr)},
                {"actual_max_same_phase_tiles", actualMaxSamePhase}, {"same_phase_steps", samePhaseSteps}, {"total_steps", totalSteps}}},
            {"requires_strict_clock_and_qca_export", true},
            {"scope", "Only requested node-coordinate edits and optional explicit routing order; bounded rerouting and native mapping. Explicit routing order is attempted once without fallback. No automatic placement or topology optimization. Downstream absolute-clock, RTL-equivalence, and exported-QCA certificates are required."}};
        std::ofstream out(argv[4]);
        if (!out) throw std::runtime_error("cannot write edit candidate");
        out << json::serialize(result) << '\n'; out.close();
        if (!out) throw std::runtime_error("cannot finish edit candidate");
        if (!error.empty()) { std::cerr << error << '\n'; return 10; }
        std::cout << "IFCN_EDIT_CANDIDATE_READY\n";
        return 0;
    } catch (const std::exception &exception) {
        std::cerr << "ifcn_layout_edit failed: " << exception.what() << '\n'; return 1;
    }
}
